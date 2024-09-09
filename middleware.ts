import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import CryptoJS from 'crypto-js';
import { isDevelopment } from '@/utils/env';
import { isTokenValid } from '@/utils/server/passwordUtils';

export function middleware(req: NextRequest) {
  const url = req.nextUrl.clone();

  // Redirect /all to /answers, preserving query parameters
  if (url.pathname === '/all') {
    url.pathname = '/answers';
    return NextResponse.redirect(url, { status: 308 }); // 308 is for permanent redirect
  }

  // Redirect HTTP to HTTPS
  if (url.protocol === 'http:' && !isDevelopment()) {
    url.protocol = 'https:';
    return NextResponse.redirect(url);
  }

  const allowed_paths_starts = [
    '/login',
    '/robots.txt',
    '/favicon.ico',
    '/contact',
    '/api/',
    '/_next',
  ];

  const pathname_is_private =
    !allowed_paths_starts.some((path) => url.pathname.startsWith(path)) &&
    !(url.pathname.startsWith('/answers/') && url.pathname !== '/answers/') &&
    !url.pathname.endsWith('.png') &&
    !url.pathname.endsWith('.jpg') &&
    !url.pathname.endsWith('.gif');

  if (pathname_is_private) {
    // Authentication check
    const cookie = req.cookies.get('siteAuth');
    const storedHashedToken = process.env.SECURE_TOKEN_HASH;
    if (
      !cookie ||
      CryptoJS.SHA256(cookie.value.split(':')[0]).toString() !==
        storedHashedToken ||
      !isTokenValid(cookie.value)
    ) {
      console.log('Authentication failed');

      // For API routes, return a 401 Unauthorized response
      if (url.pathname.startsWith('/api')) {
        const response = new NextResponse(
          JSON.stringify({
            success: false,
            message: 'Authentication required',
          }),
          {
            status: 401,
            headers: {
              'content-type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type',
            },
          },
        );
        return response;
      }

      // For other routes, redirect to login
      console.log('Redirecting to /login');
      url.pathname = '/login';
      url.searchParams.set('redirect', req.nextUrl.pathname);
      return NextResponse.redirect(url);
    }
  }

  const allowedOrigins = [process.env.NEXT_PUBLIC_BASE_URL];
  const origin = req.headers.get('origin');

  // Explicitly type the corsHeaders object
  const corsHeaders: {
    'Access-Control-Allow-Methods': string;
    'Access-Control-Allow-Headers': string;
    'Access-Control-Allow-Origin'?: string;
  } = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (origin && allowedOrigins.includes(origin)) {
    corsHeaders['Access-Control-Allow-Origin'] = origin;
  }

  if (url.pathname === '/api/chat') {
    return NextResponse.next();
  }

  return NextResponse.next({
    headers: corsHeaders,
  });
}
