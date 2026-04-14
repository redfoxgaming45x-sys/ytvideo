#!/bin/bash
set -e

echo "📥 yt-dlp ডাউনলোড করা হচ্ছে..."

# লেটেস্ট yt-dlp লিনাক্স বাইনারি ডাউনলোড (Python ইন্ডিপেন্ডেন্ট)
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o yt-dlp

# এক্সিকিউটেবল পারমিশন দেওয়া
chmod +x yt-dlp

# বর্তমান ডিরেক্টরি পাথ বের করা
CURRENT_DIR=$(pwd)

echo "✅ yt-dlp ডাউনলোড সম্পন্ন: $CURRENT_DIR/yt-dlp"
