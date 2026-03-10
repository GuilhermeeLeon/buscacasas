@echo off
cd /d "%~dp0"
npm run scrape >> logs\scraper.log 2>&1
