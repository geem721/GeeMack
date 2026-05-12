# TalkBridge — GEEMACK Platform

Universal AI-powered translation app with:
- Auto language detection
- Camera OCR (point at real-world text)
- Document translation (PDF, DOCX, XLSX, PPTX, images, and more)
- Voice input + text-to-speech
- Translation history

## Project Structure

```
talkbridge/
├── api/
│   └── translate.js     ← Secure Vercel serverless function
├── public/
│   └── index.html       ← The full app
├── vercel.json          ← Vercel configuration
└── README.md
```

## Deploy to Vercel

1. Push this folder to GitHub (repo: GEEMACK)
2. Go to vercel.com → Import project from GitHub
3. Add environment variable:
   - Name:  ANTHROPIC_API_KEY
   - Value: your sk-ant-... key
4. Click Deploy

## Local Development

Open `public/index.html` with VS Code Live Server for UI changes.
The `/api/translate` proxy only works when deployed to Vercel.
