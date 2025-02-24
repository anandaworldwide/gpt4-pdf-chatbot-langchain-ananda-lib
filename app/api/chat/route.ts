/**
 * This file implements a custom chat route for handling streaming responses on Vercel production.
 *
 * Core functionality:
 * - Handles both standard chat and model comparison requests
 * - Implements server-sent events (SSE) for real-time streaming
 * - Manages rate limiting per user/IP
 * - Validates and sanitizes all inputs
 * - Integrates with Pinecone for vector search
 * - Supports filtering by media type and collection
 * - Optional response persistence to Firestore
 *
 * Request flow:
 * 1. Input validation and sanitization
 * 2. Rate limit checking
 * 3. Pinecone setup with filters (media type, collection, library)
 * 4. Vector store and retriever initialization
 * 5. LLM chain execution with streaming
 * 6. Optional response saving to Firestore
 *
 * Error handling:
 * - Handles Pinecone connection issues
 * - Manages OpenAI rate limits and quotas
 * - Validates JSON structure and input lengths
 * - Provides detailed error messages for debugging
 *
 * Security features:
 * - XSS prevention through input sanitization
 * - Rate limiting per IP
 * - Input length restrictions
 * - Collection access validation
 *
 * Performance considerations:
 * - Uses streaming to reduce time-to-first-token
 * - Concurrent document retrieval and response generation
 * - Efficient filter application at the vector store level
 */

// Custom route required for Vercel production streaming support
// See: https://vercel.com/docs/functions/streaming/quickstart
//
// TODO: wrap this in apiMiddleware
//
import { NextRequest, NextResponse } from 'next/server';
import { Document } from 'langchain/document';
import { OpenAIEmbeddings } from '@langchain/openai';
import { PineconeStore } from '@langchain/pinecone';
import { makeChain } from '@/utils/server/makechain';
import { getPineconeClient } from '@/utils/server/pinecone-client';
import { getPineconeIndexName } from '@/config/pinecone';
import * as fbadmin from 'firebase-admin';
import { db } from '@/services/firebase';
import { getAnswersCollectionName } from '@/utils/server/firestoreUtils';
import { Index, RecordMetadata } from '@pinecone-database/pinecone';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { loadSiteConfigSync } from '@/utils/server/loadSiteConfig';
import validator from 'validator';
import { genericRateLimiter } from '@/utils/server/genericRateLimiter';
import { SiteConfig } from '@/types/siteConfig';
import { StreamingResponseData } from '@/types/StreamingResponseData';
import { getClientIp } from '@/utils/server/ipUtils';

export const runtime = 'nodejs';
export const maxDuration = 240;

interface ChatRequestBody {
  collection: string;
  question: string;
  history: [string, string][];
  privateSession: boolean;
  mediaTypes: Record<string, boolean>;
  sourceCount: number;
}

interface ComparisonRequestBody extends ChatRequestBody {
  modelA: string;
  modelB: string;
  temperatureA: number;
  temperatureB: number;
  useExtraSources: boolean;
  sourceCount: number;
}

// Define a minimal type that matches PineconeStore.fromExistingIndex expectations
type PineconeStoreOptions = {
  pineconeIndex: Index<RecordMetadata>;
  textKey: string;
  // We omit filter since we're handling it at runtime
};

// Helper function to check if a string matches a pattern with wildcards
function matchesPattern(origin: string, pattern: string): boolean {
  // Escape special regex characters but not the asterisk
  const escapedPattern = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*/g, '.*');
  const regex = new RegExp(`^${escapedPattern}$`, 'i');
  return regex.test(origin);
}

// Middleware to handle CORS
function handleCors(req: NextRequest, siteConfig: SiteConfig) {
  const origin = req.headers.get('origin');

  // If no origin header, allow the request (likely a server-side or direct API call)
  if (!origin) {
    return null;
  }

  // Allow localhost for development
  if (origin.startsWith('http://localhost:') || origin === 'http://localhost') {
    return null;
  }

  // Check against allowedFrontEndDomains from site config
  const allowedDomains = siteConfig.allowedFrontEndDomains || [];

  for (const pattern of allowedDomains) {
    if (matchesPattern(origin, pattern)) {
      return null; // Origin is allowed
    }
  }

  // If we get here, the origin is not allowed
  console.warn(`CORS blocked request from origin: ${origin}`);
  return NextResponse.json(
    { error: 'CORS policy: No access from this origin' },
    { status: 403 },
  );
}

// Function to add CORS headers to responses for allowed origins
function addCorsHeaders(
  response: NextResponse,
  req: NextRequest,
  siteConfig: SiteConfig,
): NextResponse {
  const origin = req.headers.get('origin');

  // If no origin, no need to add CORS headers
  if (!origin) {
    return response;
  }

  // Check if origin is allowed
  const isLocalhost =
    origin.startsWith('http://localhost:') || origin === 'http://localhost';
  const allowedDomains = siteConfig.allowedFrontEndDomains || [];
  const isAllowedDomain = allowedDomains.some((pattern) =>
    matchesPattern(origin, pattern),
  );

  // If origin is allowed, add CORS headers
  if (isLocalhost || isAllowedDomain) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization',
    );
    response.headers.set('Access-Control-Allow-Credentials', 'true');
  }

  return response;
}

async function validateAndPreprocessInput(req: NextRequest): Promise<
  | {
      sanitizedInput: ChatRequestBody;
      originalQuestion: string;
    }
  | NextResponse
> {
  // Parse and validate request body
  let requestBody: ChatRequestBody;
  try {
    requestBody = await req.json();
  } catch (error) {
    console.error('Error parsing request body:', error);
    console.log('Raw request body:', await req.text());
    return NextResponse.json(
      { error: 'Invalid JSON in request body' },
      { status: 400 },
    );
  }

  const { collection, question } = requestBody;

  // Validate question length
  if (
    typeof question !== 'string' ||
    !validator.isLength(question, { min: 1, max: 4000 })
  ) {
    return NextResponse.json(
      { error: 'Invalid question. Must be between 1 and 4000 characters.' },
      { status: 400 },
    );
  }

  const originalQuestion = question;
  // Sanitize the input to prevent XSS attacks
  const sanitizedQuestion = validator
    .escape(question.trim())
    .replaceAll('\n', ' ');

  // Validate collection
  if (
    typeof collection !== 'string' ||
    !['master_swami', 'whole_library'].includes(collection)
  ) {
    return NextResponse.json(
      { error: 'Invalid collection provided' },
      { status: 400 },
    );
  }

  return {
    sanitizedInput: {
      ...requestBody,
      question: sanitizedQuestion,
    },
    originalQuestion,
  };
}

async function applyRateLimiting(
  req: NextRequest,
  siteConfig: SiteConfig,
): Promise<NextResponse | null> {
  const isAllowed = await genericRateLimiter(
    req,
    null,
    {
      windowMs: 24 * 60 * 60 * 1000, // 24 hours
      max: siteConfig.queriesPerUserPerDay,
      name: 'query',
    },
    req.ip,
  );

  if (!isAllowed) {
    return NextResponse.json(
      { error: 'Daily query limit reached. Please try again tomorrow.' },
      { status: 429 },
    );
  }

  return null; // Rate limiting passed
}

// Define a custom type for our filter structure
type PineconeFilter = {
  $and: Array<{
    [key: string]: {
      $in: string[];
    };
  }>;
};

async function setupPineconeAndFilter(
  collection: string,
  mediaTypes: Record<string, boolean>,
  siteConfig: SiteConfig,
): Promise<{ index: Index<RecordMetadata>; filter: PineconeFilter }> {
  const pinecone = await getPineconeClient();
  const index = pinecone.Index(
    getPineconeIndexName() || '',
  ) as Index<RecordMetadata>;

  const filter: PineconeFilter = {
    $and: [{ type: { $in: [] } }],
  };

  if (
    collection === 'master_swami' &&
    siteConfig.collectionConfig?.master_swami
  ) {
    filter.$and.push({
      author: { $in: ['Paramhansa Yogananda', 'Swami Kriyananda'] },
    });
  }

  // Apply library filter only if includedLibraries is non-empty
  if (siteConfig.includedLibraries && siteConfig.includedLibraries.length > 0) {
    const libraryNames = siteConfig.includedLibraries.map((lib) =>
      typeof lib === 'string' ? lib : lib.name,
    );
    filter.$and.push({ library: { $in: libraryNames } });
  }

  const enabledMediaTypes = siteConfig.enabledMediaTypes || [
    'text',
    'audio',
    'youtube',
  ];
  enabledMediaTypes.forEach((type) => {
    if (mediaTypes[type]) {
      filter.$and[0].type.$in.push(type);
    }
  });
  if (filter.$and[0].type.$in.length === 0) {
    filter.$and[0].type.$in = enabledMediaTypes;
  }

  return { index, filter };
}

async function setupVectorStoreAndRetriever(
  index: Index<RecordMetadata>,
  filter: PineconeFilter | undefined,
  sendData: (data: {
    token?: string;
    sourceDocs?: Document[];
    done?: boolean;
    error?: string;
    docId?: string;
  }) => void,
  sourceCount: number = 4,
): Promise<{
  vectorStore: PineconeStore;
  retriever: ReturnType<PineconeStore['asRetriever']>;
  documentPromise: Promise<Document[]>;
}> {
  let resolveWithDocuments: (value: Document[]) => void;
  const documentPromise = new Promise<Document[]>((resolve) => {
    resolveWithDocuments = resolve;
  });

  const vectorStoreOptions: PineconeStoreOptions = {
    pineconeIndex: index,
    textKey: 'text',
  };

  const vectorStore = await PineconeStore.fromExistingIndex(
    new OpenAIEmbeddings({}),
    vectorStoreOptions,
  );

  const retriever = vectorStore.asRetriever({
    callbacks: [
      {
        handleRetrieverError(error) {
          console.error('Retriever error:', error);
          resolveWithDocuments([]);
        },
        handleRetrieverEnd(docs: Document[]) {
          resolveWithDocuments(docs);
          sendData({ sourceDocs: docs });
        },
      } as Partial<BaseCallbackHandler>,
    ],
    k: sourceCount,
  });

  return { vectorStore, retriever, documentPromise };
}

// This function executes the language model chain and handles the streaming response
async function setupAndExecuteLanguageModelChain(
  retriever: ReturnType<PineconeStore['asRetriever']>,
  sanitizedQuestion: string,
  history: [string, string][],
  sendData: (data: StreamingResponseData) => void,
  sourceCount: number = 4,
  filter?: PineconeFilter,
  resolveDocs?: (docs: Document[]) => void,
): Promise<string> {
  try {
    const chain = await makeChain(
      retriever,
      { model: 'gpt-4o', temperature: 0 },
      sourceCount,
      filter,
      sendData,
      resolveDocs,
    );

    // Format chat history for the language model
    const pastMessages = history
      .map((message: [string, string]) => {
        return [`Human: ${message[0]}`, `Assistant: ${message[1]}`].join('\n');
      })
      .join('\n');

    let fullResponse = '';

    // Invoke the chain with callbacks for streaming tokens
    const chainPromise = chain.invoke(
      {
        question: sanitizedQuestion,
        chat_history: pastMessages,
      },
      {
        callbacks: [
          {
            // Callback for handling new tokens from the language model
            handleLLMNewToken(token: string) {
              fullResponse += token;
              sendData({ token });
            },
            // Callback for handling the end of the chain execution
            handleChainEnd() {
              sendData({ done: true });
            },
          } as Partial<BaseCallbackHandler>,
        ],
      },
    );

    // Wait for the chain to complete
    await chainPromise;
    return fullResponse;
  } catch (error) {
    console.error('Error in setupAndExecuteLanguageModelChain:', error);
    throw error;
  }
}

// Function to save the answer and related information to Firestore
async function saveAnswerToFirestore(
  originalQuestion: string,
  fullResponse: string,
  collection: string,
  promiseDocuments: Document[],
  history: [string, string][],
  clientIP: string,
): Promise<string> {
  const answerRef = db.collection(getAnswersCollectionName());
  const answerEntry = {
    question: originalQuestion,
    answer: fullResponse,
    collection: collection,
    sources: JSON.stringify(promiseDocuments),
    likeCount: 0,
    history: history.map((messagePair: [string, string]) => ({
      question: messagePair[0],
      answer: messagePair[1],
    })),
    ip: clientIP,
    timestamp: fbadmin.firestore.FieldValue.serverTimestamp(),
  };
  const docRef = await answerRef.add(answerEntry);
  return docRef.id;
}

// Function for handling errors and sending appropriate error messages
function handleError(
  error: unknown,
  sendData: (data: StreamingResponseData) => void,
) {
  console.error('Error in chat route:', error);
  if (error instanceof Error) {
    // Handle specific error cases
    if (error.name === 'PineconeNotFoundError') {
      console.error('Pinecone index not found:', getPineconeIndexName());
      sendData({
        error:
          'The specified Pinecone index does not exist. Please notify your administrator.',
      });
    } else if (error.message.includes('429')) {
      // Log the first 10 characters of the API key for debugging purposes
      console.log(
        'First 10 chars of OPENAI_API_KEY:',
        process.env.OPENAI_API_KEY?.substring(0, 10),
      );
      sendData({
        error:
          'The site has exceeded its current quota with OpenAI, please tell an admin to check the plan and billing details.',
      });
    } else {
      sendData({ error: error.message || 'Something went wrong' });
    }
  } else {
    sendData({ error: 'An unknown error occurred' });
  }
}

// Add new function near other handlers
async function handleComparisonRequest(
  req: NextRequest,
  requestBody: ComparisonRequestBody,
  siteConfig: SiteConfig,
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendData = (data: StreamingResponseData & { model?: string }) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // Set up Pinecone and filter
        const { index, filter } = await setupPineconeAndFilter(
          requestBody.collection,
          requestBody.mediaTypes,
          siteConfig,
        );

        // Use the source count directly from the request body
        // The frontend is responsible for using siteConfig.defaultNumSources
        const sourceCount = requestBody.sourceCount || 4;

        // Setup Vector Store and Retriever
        const { retriever, documentPromise } =
          await setupVectorStoreAndRetriever(
            index,
            filter,
            (data) => {
              if (data.sourceDocs) {
                sendData({ ...data, model: 'A' });
                sendData({ ...data, model: 'B' });
              }
            },
            sourceCount,
          );

        // Create chains for both models
        const chainA = await makeChain(
          retriever,
          {
            model: requestBody.modelA,
            temperature: requestBody.temperatureA,
            label: 'A',
          },
          sourceCount,
        );
        const chainB = await makeChain(
          retriever,
          {
            model: requestBody.modelB,
            temperature: requestBody.temperatureB,
            label: 'B',
          },
          sourceCount,
        );

        // Format chat history
        const pastMessages = requestBody.history
          .map((message: [string, string]) => {
            return [`Human: ${message[0]}`, `Assistant: ${message[1]}`].join(
              '\n',
            );
          })
          .join('\n');

        // Run both chains concurrently
        await Promise.all([
          chainA.invoke(
            {
              question: requestBody.question,
              chat_history: pastMessages,
            },
            {
              callbacks: [
                {
                  handleLLMNewToken(token: string) {
                    // Only send the token if it's not empty or just whitespace
                    if (token.trim()) {
                      sendData({ token, model: 'A' });
                    }
                  },
                } as Partial<BaseCallbackHandler>,
              ],
            },
          ),
          chainB.invoke(
            {
              question: requestBody.question,
              chat_history: pastMessages,
            },
            {
              callbacks: [
                {
                  handleLLMNewToken(token: string) {
                    // Only send the token if it's not empty or just whitespace
                    if (token.trim()) {
                      sendData({ token, model: 'B' });
                    }
                  },
                } as Partial<BaseCallbackHandler>,
              ],
            },
          ),
        ]);

        // Send source documents once at the end
        const sourceDocs = await documentPromise;
        sendData({ sourceDocs });

        // Signal completion
        sendData({ done: true });
        controller.close();
      } catch (error) {
        handleError(error, sendData);
        controller.close();
      }
    },
  });

  // Replace standard response with one that has CORS headers
  const response = new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });

  return addCorsHeaders(response, req, siteConfig);
}

// Handle OPTIONS requests for CORS preflight
export async function OPTIONS(req: NextRequest) {
  const siteConfig = loadSiteConfigSync();

  if (!siteConfig) {
    return NextResponse.json(
      { error: 'Failed to load site configuration' },
      { status: 500 },
    );
  }

  // Create a basic response
  const response = new NextResponse(null, { status: 204 });

  // Add CORS headers and return
  return addCorsHeaders(response, req, siteConfig);
}

// main POST handler
export async function POST(req: NextRequest) {
  // Validate and preprocess the input
  const validationResult = await validateAndPreprocessInput(req);
  if (validationResult instanceof NextResponse) {
    return validationResult;
  }

  const { sanitizedInput, originalQuestion } = validationResult;

  // Check if this is a comparison request
  const isComparison = 'modelA' in sanitizedInput;

  // Load site configuration
  const siteConfig = loadSiteConfigSync();

  if (!siteConfig) {
    return NextResponse.json(
      { error: 'Failed to load site configuration' },
      { status: 500 },
    );
  }

  // Check CORS restrictions
  const corsCheckResult = handleCors(req, siteConfig);
  if (corsCheckResult) {
    return corsCheckResult;
  }

  if (isComparison) {
    return handleComparisonRequest(
      req,
      sanitizedInput as ComparisonRequestBody,
      siteConfig,
    );
  }

  // Apply rate limiting
  const rateLimitResult = await applyRateLimiting(req, siteConfig);
  if (rateLimitResult) {
    return rateLimitResult;
  }

  // Get client IP for logging purposes
  const clientIP = getClientIp(req);

  // Set up streaming response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendData = (data: StreamingResponseData) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // Set up Pinecone and filter
        const { index, filter } = await setupPineconeAndFilter(
          sanitizedInput.collection,
          sanitizedInput.mediaTypes,
          siteConfig,
        );

        const { retriever } = await setupVectorStoreAndRetriever(
          index,
          filter,
          sendData,
          sanitizedInput.sourceCount || 4,
        );

        // Factory function to define promise and resolver together
        const createDocumentPromise = () => {
          let resolveFn: (docs: Document[]) => void;
          const promise = new Promise<Document[]>((resolve) => {
            resolveFn = resolve;
          });
          return { documentPromise: promise, resolveWithDocuments: resolveFn! };
        };
        const { documentPromise, resolveWithDocuments } =
          createDocumentPromise();

        // Execute language model chain
        const fullResponse = await setupAndExecuteLanguageModelChain(
          retriever,
          sanitizedInput.question,
          sanitizedInput.history,
          sendData,
          sanitizedInput.sourceCount || 4,
          filter,
          resolveWithDocuments,
        );

        // Wait for documents for Firestore, but sources are already sent
        const promiseDocuments = await documentPromise;

        if (promiseDocuments.length === 0) {
          console.warn(
            `Warning: No sources returned for query: "${sanitizedInput.question}"`,
          );
          console.log('Filter used:', JSON.stringify(filter));
          console.log('Pinecone index:', getPineconeIndexName());
        }

        // Grok  Said remove this line if sending in the chain is sufficient.
        // sendData({ sourceDocs: promiseDocuments });

        // Save answer to Firestore if not a private session
        if (!sanitizedInput.privateSession) {
          const docId = await saveAnswerToFirestore(
            originalQuestion,
            fullResponse,
            sanitizedInput.collection,
            promiseDocuments,
            sanitizedInput.history,
            clientIP,
          );
          sendData({ docId });
        }

        controller.close();
      } catch (error: unknown) {
        console.error('Error in stream handler:', error);
        handleError(error, sendData);
      } finally {
        console.log('Stream processing ended');
        controller.close();
      }
    },
  });

  // Return streaming response
  const response = new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });

  return addCorsHeaders(response, req, siteConfig);
}
