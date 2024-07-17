import os
import uuid
from yt_dlp import YoutubeDL
from mutagen.mp3 import MP3
from mutagen.id3 import ID3, TIT2, TPE1, TALB, COMM

def download_youtube_audio(url: str, output_path: str = '.'):
    random_filename = str(uuid.uuid4())
    
    ydl_opts = {
        'format': 'bestaudio/best',
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '192',
        }],
        'outtmpl': os.path.join(output_path, f'{random_filename}.%(ext)s'),
    }

    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            
            audio_path = os.path.join(output_path, f"{random_filename}.mp3")

            if not os.path.exists(audio_path):
                raise FileNotFoundError(f"Could not find the downloaded MP3 file: {audio_path}")
        
        # Get and add metadata to MP3
        metadata = {
            "title": info['title'],
            "author": info['uploader'],
            "description": info.get('description', '')
        }
        add_metadata_to_mp3(audio_path, metadata, url)

        print(f"Downloaded and extracted audio successfully: {info['title']}")
        print(f"File saved as: {audio_path}")

        return {
            'audio_path': audio_path,
            'title': info['title'],
            'author': info['uploader'],
            'url': url
        }
    except Exception as e:
        print(f"An error occurred while downloading YouTube audio: {e}")
        return None

def add_metadata_to_mp3(mp3_path: str, metadata: dict, url: str):
    try:
        audio = MP3(mp3_path, ID3=ID3)
        
        if audio.tags is None:
            audio.add_tags()

        audio.tags.add(TIT2(encoding=3, text=metadata['title']))
        audio.tags.add(TPE1(encoding=3, text=metadata['author']))
        audio.tags.add(TALB(encoding=3, text="YouTube"))
        audio.tags.add(COMM(encoding=3, lang='eng', desc='desc', text=metadata['description']))
        audio.tags.add(COMM(encoding=3, lang='eng', desc='url', text=url))

        audio.save()
        print("Metadata added successfully to MP3.")
    except Exception as e:
        print(f"An error occurred while adding metadata to MP3: {e}")        
