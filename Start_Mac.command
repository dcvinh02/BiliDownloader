#!/bin/bash
cd "$(dirname "$0")"
if [ -d "dist/mac-arm64/BiliDownloader.app" ]; then
  open "dist/mac-arm64/BiliDownloader.app"
  exit 0
elif [ -d "dist/mac/BiliDownloader.app" ]; then
  open "dist/mac/BiliDownloader.app"
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[!] Khong tim thay Node.js / npm. Hay cai Node.js 20+ hoac dung file BiliDownloader.dmg."
  read -p "Nhan Enter de dong..."
  exit 1
fi

npm start
