# 🎵 Spotify Playlist Exporter

A beautiful, dark-themed web app to export any **public Spotify playlist** to PDF — including **song name**, **artists**, **ISRC codes**, and **Spotify links**.

## ✨ Features

- 🎵 Fetches all tracks from any public Spotify playlist
- 🔢 Retrieves **ISRC codes** directly from the Spotify API
- 📄 Exports a professional **PDF** with cover page + full track table
- 📋 **Copy All** to clipboard (name, artists, ISRC, link)
- ♾️ Handles large playlists (auto-paginated, 100 tracks/request)
- 🔗 Clickable links in the PDF

## 🚀 How to Use

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Create an App → copy your **Client ID** and **Client Secret**
3. Paste your credentials and any **public playlist URL** into the app
4. Click **Fetch Playlist** → then **Export PDF**

## 🛠️ Local Development

Just open `index.html` in any browser — no build step required.

## ☁️ Deploy to Vercel

Click below or connect this repo on [vercel.com](https://vercel.com):

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/MindMatrix-07/PlaylistinfoExporter)

## 📦 Tech Stack

- Vanilla HTML / CSS / JavaScript
- [Spotify Web API](https://developer.spotify.com/documentation/web-api) (Client Credentials flow)
- [jsPDF](https://github.com/parallax/jsPDF) for PDF generation

## ⚠️ Notes

- Works with **public playlists only** (no login required)
- ISRC codes are fetched from Spotify's `external_ids.isrc` field
- Your credentials are never stored or sent anywhere except Spotify's servers
