const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const { exec } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { pipeline } = require('stream');
const { promisify } = require('util');
const streamPipeline = promisify(pipeline);
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// Configuration
const ANDROID_JAR = path.join(__dirname, 'android.jar');
const KEYSTORE_PATH = path.join(__dirname, 'debug.keystore');
const TEMP_DIR = path.join(__dirname, 'temp');
const TOOLS_DIR = path.join(__dirname, 'tools');

// Ensure directories exist
fs.ensureDirSync(TEMP_DIR);
fs.ensureDirSync(TOOLS_DIR);
// ============================================
// AUTO-DOWNLOAD REQUIRED FILES
// ============================================

async function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        console.log(`📥 Downloading: ${path.basename(destPath)}`);
        console.log(`   From: ${url}`);
        console.log(`   To: ${destPath}`);
        
        const file = fs.createWriteStream(destPath);
        https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                downloadFile(response.headers.location, destPath)
                    .then(resolve)
                    .catch(reject);
                return;
            }
            
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }
            
            const totalSize = parseInt(response.headers['content-length'], 10);
            let downloadedSize = 0;
            
            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                if (totalSize) {
                    const progress = ((downloadedSize / totalSize) * 100).toFixed(1);
                    process.stdout.write(`\r   Progress: ${progress}% (${(downloadedSize / 1024 / 1024).toFixed(1)}MB / ${(totalSize / 1024 / 1024).toFixed(1)}MB)`);
                }
            });
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                console.log(`\n✅ Downloaded: ${path.basename(destPath)}`);
                resolve();
            });
            
            file.on('error', (err) => {
                fs.unlink(destPath, () => {});
                reject(err);
            });
        }).on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}
async function downloadAndroidJar() {
}

async function ensureDependencies() {
    console.log('═══════════════════════════════════════');
    console.log('   🔧 Checking Dependencies');
    console.log('═══════════════════════════════════════');
    
    if (!fs.existsSync(ANDROID_JAR)) {
        console.log('⚠ android.jar not found. Downloading...');
        const success = await downloadAndroidJar();
        if (!success) {
            console.error('❌ Failed to download android.jar');
            console.error('   Please manually place android.jar in the server directory');
            console.error('   Download from: https://developer.android.com/studio');
        }
    } else {
        console.log('✅ android.jar found');
    }
    
    if (!fs.existsSync(KEYSTORE_PATH)) {
        console.log('⚠ debug.keystore not found. Generating...');
        try {
            const genCmd = `keytool -genkey -v -keystore ${KEYSTORE_PATH} -alias androiddebugkey ` +
                          `-keyalg RSA -keysize 2048 -validity 10000 -storepass android -keypass android ` +
                          `-dname "CN=Debug, OU=Debug, O=Debug, L=Debug, ST=Debug, C=US"`;
            await execPromise(genCmd);
            console.log('✅ debug.keystore generated');
        } catch (error) {
            console.warn('⚠ Could not generate debug.keystore:', error.message);
            console.warn('   APKs will be signed with a fallback method');
        }
    } else {
        console.log('✅ debug.keystore found');
    }
    
    console.log('\n🔍 Checking Android build tools...');
    
    const tools = ['d8', 'aapt', 'zipalign', 'apksigner'];
    for (const tool of tools) {
        try {
            await execPromise(`which ${tool}`);
            console.log(`   ✅ ${tool} found`);
        } catch (error) {
            console.log(`   ⚠ ${tool} not found in PATH, will try fallback methods`);
        }
    }
    
    console.log('═══════════════════════════════════════\n');
}
// ============================================
// HEALTH CHECK ENDPOINT
// ============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        checks: {
            androidJar: fs.existsSync(ANDROID_JAR),
            keystore: fs.existsSync(KEYSTORE_PATH),
            tempDir: fs.existsSync(TEMP_DIR)
        },
        tools: {
            d8: checkTool('d8'),
            aapt: checkTool('aapt'),
            zipalign: checkTool('zipalign'),
            apksigner: checkTool('apksigner')
        }
    });
});

function checkTool(tool) {
    try {
        const result = require('child_process').execSync(`which ${tool}`, { stdio: 'pipe' });
        return result.toString().trim() || false;
    } catch (error) {
        return false;
    }
}
// ============================================
// MAIN BUILD ENDPOINT (full APK: compile -> dex -> package -> sign)
// ============================================
app.post('/build', async (req, res) => {
    const { code, packageName = 'com.user.app', appName = 'MyApp' } = req.body;
    
    if (!code || code.trim().length === 0) {
        return res.status(400).json({ error: 'No code provided' });
    }
    
    if (code.trim().length > 100000) {
        return res.status(400).json({ error: 'Code too large (max 100KB)' });
    }
    
    if (!fs.existsSync(ANDROID_JAR)) {
        console.error('❌ android.jar not found!');
        return res.status(500).json({ 
            error: 'Build server misconfigured: android.jar missing. Please run ensureDependencies()' 
        });
    }
    
    const buildId = crypto.randomBytes(8).toString('hex');
    const buildDir = path.join(TEMP_DIR, buildId);
    const startTime = Date.now();
    
    console.log(`[${buildId}] 🚀 Starting build for: ${appName}`);
    console.log(`[${buildId}] 📦 Package: ${packageName}`);
    console.log(`[${buildId}] 📝 Code length: ${code.length} chars`);
    
    try {
        await createProjectStructure(buildDir, code, packageName, appName);
        console.log(`[${buildId}] ✅ Project structure created`);
        
        await compileJava(buildDir);
        console.log(`[${buildId}] ✅ Java compiled`);
        
        await convertToDex(buildDir);
        console.log(`[${buildId}] ✅ DEX generated`);
        
        await packageApk(buildDir);
        console.log(`[${buildId}] ✅ APK packaged`);
        
        await signApk(buildDir);
        console.log(`[${buildId}] ✅ APK signed`);
        
        const apkPath = path.join(buildDir, 'app-debug.apk');
        const apkSize = fs.statSync(apkPath).size;
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        
        console.log(`[${buildId}] ✅ Build complete! APK: ${(apkSize/1024/1024).toFixed(2)} MB, Duration: ${duration}s`);
        
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', `attachment; filename="${appName}.apk"`);
        res.setHeader('X-Build-Duration', duration);
        res.setHeader('X-APK-Size', apkSize);
        
        res.sendFile(apkPath, (err) => {
            fs.removeSync(buildDir);
            console.log(`[${buildId}] 🧹 Cleaned up build directory`);
        });
        
    } catch (error) {
        console.error(`[${buildId}] ❌ Build error:`, error.message);
        
        try {
            fs.removeSync(buildDir);
        } catch (cleanupError) {
            console.error(`[${buildId}] Cleanup error:`, cleanupError.message);
        }
        
        res.status(500).json({ 
            error: error.message,
            buildId: buildId
        });
    }
});
// ============================================
// RUN ENDPOINT (plain javac/java — no APK, just stdout back to Console)
// ============================================
function detectClassName(code) {
    const match = code.match(/public\s+class\s+(\w+)/);
    return match ? match[1] : 'Main';
}

async function createPlainJavaProject(dir, code) {
    const srcDir = path.join(dir, 'src');
    fs.ensureDirSync(srcDir);
    const className = detectClassName(code);
    fs.writeFileSync(path.join(srcDir, className + '.java'), code);
    return className;
}

async function compilePlainJava(dir) {
    const srcDir = path.join(dir, 'src');
    const classesDir = path.join(dir, 'classes');
    fs.ensureDirSync(classesDir);

    const javaFiles = [];
    walkDir(srcDir, (file) => { if (file.endsWith('.java')) javaFiles.push(file); });
    if (javaFiles.length === 0) throw new Error('No Java files found to compile');

    const cmd = `javac -d ${classesDir} ${javaFiles.join(' ')}`;
    await execPromise(cmd, { timeout: 30000 });
    return classesDir;
}

app.post('/run', async (req, res) => {
    const { code } = req.body;

    if (!code || code.trim().length === 0) {
        return res.status(400).json({ error: 'No code provided' });
    }
    if (code.trim().length > 100000) {
        return res.status(400).json({ error: 'Code too large (max 100KB)' });
    }

    const runId = crypto.randomBytes(8).toString('hex');
    const runDir = path.join(TEMP_DIR, 'run-' + runId);

    console.log(`[${runId}] ▶ Run requested, code length: ${code.length} chars`);

    try {
        const className = await createPlainJavaProject(runDir, code);
        const classesDir = await compilePlainJava(runDir);
        console.log(`[${runId}] ✅ Compiled ${className}.java`);

        // NOTE: stdin is not connected — Scanner/System.in in user code
        // will hang until this timeout and return an error to the client.
        const output = await execPromise(
            `java -cp ${classesDir} ${className}`,
            { timeout: 10000 }
        );

        console.log(`[${runId}] ✅ Run complete`);
        res.json({ output: output || '' });
    } catch (error) {
        console.error(`[${runId}] ❌ Run error:`, error.message);
        res.status(500).json({ error: error.message });
    } finally {
        try { fs.removeSync(runDir); } catch (e) { /* ignore */ }
    }
});
// ============================================
// BUILD FUNCTIONS (used by /build only)
// ============================================

async function createProjectStructure(dir, code, packageName, appName) {
    const srcDir = path.join(dir, 'src', packageName.replace(/\./g, '/'));
    fs.ensureDirSync(srcDir);
    
    const mainActivity = `package ${packageName};

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;
import android.widget.LinearLayout;
import android.graphics.Color;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.util.Log;

public class MainActivity extends Activity {
    private static final String TAG = "MyApp";
    private LinearLayout mainLayout;
    private TextView outputText;
    
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        try {
            mainLayout = new LinearLayout(this);
            mainLayout.setOrientation(LinearLayout.VERTICAL);
            mainLayout.setBackgroundColor(Color.parseColor("#1a1a1a"));
            mainLayout.setPadding(30, 30, 30, 30);
            
            outputText = new TextView(this);
            outputText.setTextColor(Color.WHITE);
            outputText.setTextSize(16);
            outputText.setTypeface(Typeface.MONOSPACE);
            outputText.setPadding(10, 10, 10, 10);
            outputText.setBackgroundColor(Color.parseColor("#2d2d2d"));
            
            mainLayout.addView(outputText);
            
            // ============================================
            // USER CODE STARTS HERE
            // ============================================
            ${code}
            // ============================================
            // USER CODE ENDS HERE
            // ============================================
            
            if (outputText.getText().toString().isEmpty()) {
                outputText.setText("✅ App running successfully!");
            }
            
            setContentView(mainLayout);
            
        } catch (Exception e) {
            Log.e(TAG, "Error in user code", e);
            
            TextView errorView = new TextView(this);
            errorView.setTextColor(Color.RED);
            errorView.setTextSize(16);
            errorView.setPadding(30, 30, 30, 30);
            errorView.setTypeface(Typeface.MONOSPACE);
            errorView.setText("❌ Error: " + e.toString());
            setContentView(errorView);
        }
    }
}`;

    fs.writeFileSync(path.join(srcDir, 'MainActivity.java'), mainActivity);
    
    const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${packageName}">
    <application
        android:label="${appName}"
        android:icon="@android:drawable/ic_dialog_info"
        android:allowBackup="true"
        android:theme="@android:style/Theme.NoTitleBar.Fullscreen">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>`;
    
    fs.writeFileSync(path.join(dir, 'AndroidManifest.xml'), manifest);
}

async function compileJava(dir) {
    const srcDir = path.join(dir, 'src');
    const classesDir = path.join(dir, 'classes');
    fs.ensureDirSync(classesDir);
    
    const javaFiles = [];
    walkDir(srcDir, (file) => {
        if (file.endsWith('.java')) {
            javaFiles.push(file);
        }
    });
    
    if (javaFiles.length === 0) {
        throw new Error('No Java files found to compile');
    }
    
    const cmd = `javac -d ${classesDir} -cp ${ANDROID_JAR} -source 1.8 -target 1.8 ${javaFiles.join(' ')}`;
    
    try {
        await execPromise(cmd, { timeout: 30000 });
    } catch (error) {
        const fallbackCmd = `javac -d ${classesDir} -cp ${ANDROID_JAR} ${javaFiles.join(' ')}`;
        await execPromise(fallbackCmd, { timeout: 30000 });
    }
}

async function convertToDex(dir) {
    const classesDir = path.join(dir, 'classes');
    const dexDir = path.join(dir, 'dex');
    fs.ensureDirSync(dexDir);
    
    const classFiles = [];
    walkDir(classesDir, (file) => {
        if (file.endsWith('.class')) {
            classFiles.push(file);
        }
    });
    
    if (classFiles.length === 0) {
        throw new Error('No .class files found to convert to DEX');
    }
    
    try {
        const cmd = `d8 --lib ${ANDROID_JAR} --output ${dexDir} ${classFiles.join(' ')}`;
        await execPromise(cmd, { timeout: 30000 });
        return;
    } catch (error) {
        console.warn('d8 failed, trying dx...');
    }
    
    try {
        const cmd = `dx --dex --output=${path.join(dexDir, 'classes.dex')} ${classFiles.join(' ')}`;
        await execPromise(cmd, { timeout: 30000 });
        return;
    } catch (error) {
        throw new Error('DEX conversion failed: ' + error.message);
    }
}
async function packageApk(dir) {
    const dexDir = path.join(dir, 'dex');
    const manifestPath = path.join(dir, 'AndroidManifest.xml');
    
    const dexFiles = [];
    walkDir(dexDir, (file) => {
        if (file.endsWith('.dex')) {
            dexFiles.push(file);
        }
    });
    
    if (dexFiles.length === 0) {
        throw new Error('No .dex files found');
    }
    
    const unalignedApk = path.join(dir, 'app-unaligned.apk');
    let aaptCmd = `aapt package -f -M ${manifestPath} -I ${ANDROID_JAR}`;
    
    for (const dex of dexFiles) {
        aaptCmd += ` -F ${unalignedApk} ${dex}`;
    }
    
    try {
        await execPromise(aaptCmd, { timeout: 30000 });
    } catch (error) {
        console.warn('aapt failed, using zip fallback...');
        const zipCmd = `zip -j ${unalignedApk} ${dexFiles.join(' ')} ${manifestPath}`;
        await execPromise(zipCmd, { timeout: 30000 });
    }
    
    const alignedApk = path.join(dir, 'app-aligned.apk');
    try {
        await execPromise(`zipalign -f -v 4 ${unalignedApk} ${alignedApk}`, { timeout: 30000 });
    } catch (error) {
        console.warn('zipalign failed, using unaligned APK');
        fs.copyFileSync(unalignedApk, alignedApk);
    }
}

async function signApk(dir) {
    const alignedApk = path.join(dir, 'app-aligned.apk');
    const signedApk = path.join(dir, 'app-debug.apk');
    
    if (!fs.existsSync(KEYSTORE_PATH)) {
        try {
            const genCmd = `keytool -genkey -v -keystore ${KEYSTORE_PATH} -alias androiddebugkey ` +
                          `-keyalg RSA -keysize 2048 -validity 10000 -storepass android -keypass android ` +
                          `-dname "CN=Debug, OU=Debug, O=Debug, L=Debug, ST=Debug, C=US"`;
            await execPromise(genCmd, { timeout: 30000 });
        } catch (error) {
            console.warn('Could not generate keystore, using unsigned APK');
            fs.copyFileSync(alignedApk, signedApk);
            return;
        }
    }
    
    try {
        const signCmd = `apksigner sign --ks ${KEYSTORE_PATH} --ks-pass pass:android --key-pass pass:android ` +
                       `--out ${signedApk} ${alignedApk}`;
        await execPromise(signCmd, { timeout: 30000 });
    } catch (error) {
        console.warn('apksigner failed, trying jarsigner...');
        
        try {
            const jarCmd = `jarsigner -verbose -sigalg SHA1withRSA -digestalg SHA1 ` +
                          `-keystore ${KEYSTORE_PATH} -storepass android -keypass android ` +
                          `${alignedApk} androiddebugkey`;
            await execPromise(jarCmd, { timeout: 30000 });
            fs.copyFileSync(alignedApk, signedApk);
        } catch (jarError) {
            console.warn('jarsigner failed, using unsigned APK');
            fs.copyFileSync(alignedApk, signedApk);
        }
    }
}
// ============================================
// UTILITY FUNCTIONS
// ============================================

function walkDir(dir, callback) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            walkDir(fullPath, callback);
        } else {
            callback(fullPath);
        }
    }
}

function execPromise(cmd, options = {}) {
    return new Promise((resolve, reject) => {
        const opts = {
            maxBuffer: 1024 * 1024 * 100,
            shell: '/bin/bash',
            timeout: 60000,
            ...options
        };
        
        exec(cmd, opts, (error, stdout, stderr) => {
            if (error) {
                const msg = stderr || stdout || error.message;
                reject(new Error(msg));
            } else {
                resolve(stdout || stderr);
            }
        });
    });
}

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;

ensureDependencies().then(() => {
    app.listen(PORT, () => {
        console.log('═══════════════════════════════════════');
        console.log('   🏗 Android APK Build Server');
        console.log('═══════════════════════════════════════');
        console.log(`   Port: ${PORT}`);
        console.log(`   Temp Dir: ${TEMP_DIR}`);
        console.log(`   android.jar: ${fs.existsSync(ANDROID_JAR) ? '✅ Found' : '❌ MISSING'}`);
        console.log(`   Keystore: ${fs.existsSync(KEYSTORE_PATH) ? '✅ Found' : '⚠ Will generate'}`);
        console.log('═══════════════════════════════════════');
        console.log('   Health Check: /health');
        console.log('   Build Endpoint: POST /build');
        console.log('   Run Endpoint:   POST /run');
        console.log('═══════════════════════════════════════');
        console.log('   Ready for builds! 🚀');
    });
});

process.on('exit', () => {
    console.log('🧹 Cleaning up temp directory...');
    try {
        fs.removeSync(TEMP_DIR);
    } catch (e) {}
});

process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, cleaning up...');
    process.exit();
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM, cleaning up...');
    process.exit();
});
