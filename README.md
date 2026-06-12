# AdRefresh

A stupid but effective way to skip YouTube ads.

## How it works

YouTube removes the `draggable` attribute from its progress bar when an ad starts. AdRefresh watches for that change, saves your timestamp, reloads the page, and seeks back to where you left off. That's it.

## Installation

1. Go to `chrome://extensions` and enable **Developer mode**
2. Click **Load unpacked** and select this folder
3. Watch YouTube without ads

## Stack

Plain JavaScript · Chrome Extension · Manifest V3 · zero permissions

---

Built because I got tired of refreshing YouTube manually.
