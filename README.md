# 🏗 Android APK Builder

**On-demand Android APK builder for CodeForge IDE**

## 🚀 Features

- Compiles Java code to APK
- Auto-downloads android.jar
- Auto-generates debug keystore
- Supports multiple build tools (d8/dx, aapt, zipalign, apksigner)
- Real-time progress updates
- Automatic cleanup after build

## 📦 Requirements

- Node.js >= 16.0.0
- Java JDK >= 8
- Android build tools (auto-detected)

## 🛠️ Installation

```bash
# Clone repository
git clone https://github.com/yourusername/android-builder.git
cd android-builder

# Install dependencies
npm install

# Start server
npm start

# Or with auto-reload for development
npm run dev
