const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio, pcmToWavBuffer } = require('../audioUtils');
const { getSystemPrompt } = require('./prompts');
const { getOpenaiApiKey } = require('../storage');
const { connectCloud, sendCloudAudio, sendCloudText, sendCloudImage, closeCloud, setOnTurnComplete } = require('./cloud');

// Lazy-loaded to avoid circular dependency
let _localai = null;
function getLocalAi() {
    if (!_localai) _localai = require('./localai');
    return _localai;
}

const WHISPER_MODEL = 'gpt-4o-mini-transcribe';

// Provider mode: 'byok', 'cloud', or 'local'
let currentProviderMode = 'byok';

// OpenAI conversation history for context
let openaiConversationHistory = [];

// Conversation tracking variables
let currentSessionId = null;
let currentTranscription = '';
let conversationHistory = [];
let screenAnalysisHistory = [];
let currentProfile = null;
let currentCustomPrompt = null;
let isInitializingSession = false;
let currentSystemPrompt = null;
let currentTurnIndex = 0;

// Audio capture variables
let systemAudioProc = null;

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

function initializeNewSession(profile = null, customPrompt = null) {
    currentSessionId = Date.now().toString();
    currentTranscription = '';
    conversationHistory = [];
    screenAnalysisHistory = [];
    openaiConversationHistory = [];
    currentProfile = profile;
    currentCustomPrompt = customPrompt;
    currentTurnIndex = 0;
    console.log('New conversation session started:', currentSessionId, 'profile:', profile);

    if (profile) {
        sendToRenderer('save-session-context', {
            sessionId: currentSessionId,
            profile: profile,
            customPrompt: customPrompt || ''
        });
    }
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };

    conversationHistory.push(conversationTurn);
    console.log('Saved conversation turn:', conversationTurn);

    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

function saveScreenAnalysis(prompt, response, model) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const analysisEntry = {
        timestamp: Date.now(),
        prompt: prompt,
        response: response.trim(),
        model: model
    };

    screenAnalysisHistory.push(analysisEntry);
    console.log('Saved screen analysis:', analysisEntry);

    sendToRenderer('save-screen-analysis', {
        sessionId: currentSessionId,
        analysis: analysisEntry,
        fullHistory: screenAnalysisHistory,
        profile: currentProfile,
        customPrompt: currentCustomPrompt
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

function hasOpenaiKey() {
    const key = getOpenaiApiKey();
    return key && key.trim() !== '';
}

// Whisper VAD state — energy-based silence detection for real-time transcription
let whisperVadState = {
    isSpeaking: false,
    speechBuffers: [],
    silenceFrameCount: 0,
    speechFrameCount: 0,
};
const WHISPER_VAD = { energyThreshold: 0.008, speechFramesRequired: 3, silenceFramesRequired: 30 };

function calculateRMS(pcmBuffer) {
    const samples = pcmBuffer.length / 2;
    if (samples === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples; i++) {
        const s = pcmBuffer.readInt16LE(i * 2) / 32768;
        sum += s * s;
    }
    return Math.sqrt(sum / samples);
}

let _vadLogThrottle = 0;

function processWhisperVAD(pcmBuffer) {
    const rms = calculateRMS(pcmBuffer);
    const isVoice = rms > WHISPER_VAD.energyThreshold;

    // Log every 50th call so we can confirm audio is arriving without spamming
    _vadLogThrottle++;
    if (_vadLogThrottle % 50 === 1) {
        console.log('[VAD] chunk received — rms:', rms.toFixed(4), 'isVoice:', isVoice, 'isSpeaking:', whisperVadState.isSpeaking, 'bufferBytes:', pcmBuffer.length);
    }

    if (isVoice) {
        whisperVadState.speechFrameCount++;
        whisperVadState.silenceFrameCount = 0;
        if (!whisperVadState.isSpeaking && whisperVadState.speechFrameCount >= WHISPER_VAD.speechFramesRequired) {
            whisperVadState.isSpeaking = true;
            whisperVadState.speechBuffers = [];
            console.log('[VAD] Speech started');
        }
    } else {
        whisperVadState.silenceFrameCount++;
        whisperVadState.speechFrameCount = 0;
        if (whisperVadState.isSpeaking && whisperVadState.silenceFrameCount >= WHISPER_VAD.silenceFramesRequired) {
            whisperVadState.isSpeaking = false;
            const audioData = Buffer.concat(whisperVadState.speechBuffers);
            whisperVadState.speechBuffers = [];
            console.log('[VAD] Speech ended — audioData bytes:', audioData.length, '(min 24000 required)');
            // ~0.5s minimum at 24kHz 16-bit mono = 24000 bytes
            if (audioData.length >= 24000) {
                transcribeAndRespond(audioData);
            } else {
                console.log('[VAD] Utterance too short, skipped');
            }
            return;
        }
    }

    if (whisperVadState.isSpeaking) {
        whisperVadState.speechBuffers.push(Buffer.from(pcmBuffer));
    }
}

async function transcribeAndRespond(pcmBuffer) {
    const openaiApiKey = getOpenaiApiKey();
    if (!openaiApiKey) {
        console.error('[Whisper] No OpenAI API key — transcription skipped');
        return;
    }

    console.log('[Whisper] Sending', pcmBuffer.length, 'bytes to Whisper API');
    sendToRenderer('update-status', 'Transcribing...');

    try {
        const wavBuffer = pcmToWavBuffer(pcmBuffer, 24000, 1, 16);
        const formData = new FormData();
        const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });
        formData.append('file', wavBlob, 'audio.wav');
        formData.append('model', WHISPER_MODEL);
        formData.append('language', 'en');

        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${openaiApiKey}` },
            body: formData,
        });

        if (!response.ok) {
            console.error('[Whisper] API error:', response.status, await response.text());
            sendToRenderer('update-status', 'Listening...');
            return;
        }

        const result = await response.json();
        const transcript = result.text?.trim();

        if (transcript && transcript.length > 2) {
            console.log('[Whisper] Transcript:', transcript.substring(0, 80));
            const turnIndex = currentTurnIndex++;
            sendToRenderer('new-turn-transcription', { turnIndex, text: transcript });
            sendToOpenAI(transcript, turnIndex);
        }

        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('[Whisper] Transcription error:', error);
        sendToRenderer('update-status', 'Listening...');
    }
}

async function sendToOpenAI(transcription, turnIndex) {
    const openaiApiKey = getOpenaiApiKey();
    if (!openaiApiKey || !transcription?.trim()) return;

    openaiConversationHistory.push({ role: 'user', content: transcription.trim() });
    if (openaiConversationHistory.length > 20) {
        openaiConversationHistory = openaiConversationHistory.slice(-20);
    }

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${openaiApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
                    ...openaiConversationHistory,
                ],
                stream: true,
                temperature: 0.7,
                max_tokens: 1024,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('OpenAI API error:', response.status, errorText);
            sendToRenderer('update-status', `OpenAI error: ${response.status}`);
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') continue;
                try {
                    const json = JSON.parse(data);
                    const token = json.choices?.[0]?.delta?.content || '';
                    if (token) {
                        fullText += token;
                        sendToRenderer('update-turn-answer', { turnIndex, text: fullText, isAnswering: true });
                    }
                } catch (_) {}
            }
        }

        if (fullText.trim()) {
            openaiConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            sendToRenderer('update-turn-answer', { turnIndex, text: fullText.trim(), isAnswering: false });
            saveConversationTurn(transcription, fullText);
        }

        console.log('OpenAI response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('Error calling OpenAI API:', error);
        sendToRenderer('update-status', 'OpenAI error: ' + error.message);
    }
}

async function sendImageToOpenAI(base64Data, prompt) {
    const apiKey = getOpenaiApiKey();
    if (!apiKey) return { success: false, error: 'No OpenAI API key configured' };

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } },
                        { type: 'text', text: prompt },
                    ],
                }],
                stream: true,
                max_tokens: 1024,
            }),
        });

        if (!response.ok) {
            const err = await response.text();
            return { success: false, error: err };
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let isFirst = true;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') continue;
                try {
                    const json = JSON.parse(data);
                    const token = json.choices?.[0]?.delta?.content || '';
                    if (token) {
                        fullText += token;
                        sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                        isFirst = false;
                    }
                } catch (_) {}
            }
        }

        saveScreenAnalysis(prompt, fullText, 'gpt-4o-mini');
        return { success: true, text: fullText, model: 'gpt-4o-mini' };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function killExistingSystemAudioDump() {
    return new Promise(resolve => {
        console.log('Checking for existing SystemAudioDump processes...');

        const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
            stdio: 'ignore',
        });

        killProc.on('close', code => {
            if (code === 0) {
                console.log('Killed existing SystemAudioDump processes');
            } else {
                console.log('No existing SystemAudioDump processes found');
            }
            resolve();
        });

        killProc.on('error', err => {
            console.log('Error checking for existing processes (this is normal):', err.message);
            resolve();
        });

        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

async function startMacOSAudioCapture() {
    if (process.platform !== 'darwin') return false;

    await killExistingSystemAudioDump();

    console.log('Starting macOS audio capture with SystemAudioDump...');

    const { app } = require('electron');
    const path = require('path');

    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../assets', 'SystemAudioDump');
    }

    console.log('SystemAudioDump path:', systemAudioPath);

    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
        },
    };

    systemAudioProc = spawn(systemAudioPath, [], spawnOptions);

    if (!systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump');
        return false;
    }

    console.log('SystemAudioDump started with PID:', systemAudioProc.pid);

    const CHUNK_DURATION = 0.1;
    const SAMPLE_RATE = 24000;
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 2;
    const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);

    systemAudioProc.stdout.on('data', data => {
        audioBuffer = Buffer.concat([audioBuffer, data]);

        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;

            if (currentProviderMode === 'cloud') {
                sendCloudAudio(monoChunk);
            } else if (currentProviderMode === 'local') {
                getLocalAi().processLocalAudio(monoChunk);
            } else {
                if (hasOpenaiKey()) {
                    processWhisperVAD(monoChunk);
                }
            }

            if (process.env.DEBUG_AUDIO) {
                console.log(`Processed audio chunk: ${chunk.length} bytes`);
                saveDebugAudio(monoChunk, 'system_audio');
            }
        }

        const maxBufferSize = SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    systemAudioProc.stderr.on('data', data => {
        console.error('SystemAudioDump stderr:', data.toString());
    });

    systemAudioProc.on('close', code => {
        console.log('SystemAudioDump process closed with code:', code);
        systemAudioProc = null;
    });

    systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        systemAudioProc = null;
    });

    return true;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const leftSample = stereoBuffer.readInt16LE(i * 4);
        monoBuffer.writeInt16LE(leftSample, i * 2);
    }

    return monoBuffer;
}

function stopMacOSAudioCapture() {
    if (systemAudioProc) {
        console.log('Stopping SystemAudioDump...');
        systemAudioProc.kill('SIGTERM');
        systemAudioProc = null;
    }
}

function setupAiIpcHandlers() {
    ipcMain.handle('initialize-cloud', async (event, token, profile, userContext) => {
        try {
            currentProviderMode = 'cloud';
            initializeNewSession(profile);
            setOnTurnComplete((transcription, response) => {
                saveConversationTurn(transcription, response);
            });
            sendToRenderer('session-initializing', true);
            await connectCloud(token, profile, userContext);
            sendToRenderer('session-initializing', false);
            return true;
        } catch (err) {
            console.error('[Cloud] Init error:', err);
            currentProviderMode = 'byok';
            sendToRenderer('session-initializing', false);
            return false;
        }
    });

    ipcMain.handle('initialize-session', async (event, customPrompt, profile, language) => {
        console.log('[Session] initialize-session called — profile:', profile, 'language:', language);
        currentProviderMode = 'byok';
        const systemPrompt = getSystemPrompt(profile, customPrompt, false);
        currentSystemPrompt = systemPrompt;
        initializeNewSession(profile, customPrompt);
        console.log('[Session] Session initialized — providerMode:', currentProviderMode, 'hasOpenAIKey:', hasOpenaiKey());
        sendToRenderer('update-status', 'Listening...');
        return true;
    });

    ipcMain.handle('initialize-local', async (event, ollamaHost, ollamaModel, whisperModel, profile, customPrompt) => {
        currentProviderMode = 'local';
        const success = await getLocalAi().initializeLocalSession(ollamaHost, ollamaModel, whisperModel, profile, customPrompt);
        if (!success) {
            currentProviderMode = 'byok';
        }
        return success;
    });

    ipcMain.handle('send-audio-content', async (event, { data, mimeType }) => {
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending local audio:', error);
                return { success: false, error: error.message };
            }
        }
        // byok mode: run VAD
        try {
            process.stdout.write('.');
            if (hasOpenaiKey()) {
                const pcmBuffer = Buffer.from(data, 'base64');
                processWhisperVAD(pcmBuffer);
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-mic-audio-content', async (event, { data, mimeType }) => {
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending local mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        // byok mode: run VAD on mic audio
        try {
            const pcmBuffer = Buffer.from(data, 'base64');
            if (_micAudioLogCount === undefined) global._micAudioLogCount = 0;
            global._micAudioLogCount++;
            if (global._micAudioLogCount === 1) {
                console.log('[Audio] First mic audio chunk received in main process — byok VAD running');
            }
            processWhisperVAD(pcmBuffer);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-image-content', async (event, { data, prompt }) => {
        try {
            if (!data || typeof data !== 'string') {
                console.error('Invalid image data received');
                return { success: false, error: 'Invalid image data' };
            }

            const buffer = Buffer.from(data, 'base64');

            if (buffer.length < 1000) {
                console.error(`Image buffer too small: ${buffer.length} bytes`);
                return { success: false, error: 'Image buffer too small' };
            }

            process.stdout.write('!');

            if (currentProviderMode === 'cloud') {
                const sent = sendCloudImage(data);
                if (!sent) {
                    return { success: false, error: 'Cloud connection not active' };
                }
                return { success: true, model: 'cloud' };
            }

            if (currentProviderMode === 'local') {
                const result = await getLocalAi().sendLocalImage(data, prompt);
                return result;
            }

            const result = await sendImageToOpenAI(data, prompt);
            return result;
        } catch (error) {
            console.error('Error sending image:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (event, text) => {
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return { success: false, error: 'Invalid text message' };
        }

        if (currentProviderMode === 'cloud') {
            try {
                console.log('Sending text to cloud:', text);
                sendCloudText(text.trim());
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud text:', error);
                return { success: false, error: error.message };
            }
        }

        if (currentProviderMode === 'local') {
            try {
                console.log('Sending text to local Ollama:', text);
                return await getLocalAi().sendLocalText(text.trim());
            } catch (error) {
                console.error('Error sending local text:', error);
                return { success: false, error: error.message };
            }
        }

        // byok mode
        try {
            console.log('Sending text message:', text);
            const turnIndex = currentTurnIndex++;
            sendToRenderer('new-turn-transcription', { turnIndex, text: text.trim() });
            sendToOpenAI(text.trim(), turnIndex);
            return { success: true };
        } catch (error) {
            console.error('Error sending text:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-macos-audio', async event => {
        if (process.platform !== 'darwin') {
            return {
                success: false,
                error: 'macOS audio capture only available on macOS',
            };
        }

        try {
            const success = await startMacOSAudioCapture();
            return { success };
        } catch (error) {
            console.error('Error starting macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async event => {
        try {
            stopMacOSAudioCapture();
            return { success: true };
        } catch (error) {
            console.error('Error stopping macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-session', async event => {
        try {
            stopMacOSAudioCapture();

            if (currentProviderMode === 'cloud') {
                closeCloud();
                currentProviderMode = 'byok';
                return { success: true };
            }

            if (currentProviderMode === 'local') {
                getLocalAi().closeLocalSession();
                currentProviderMode = 'byok';
                return { success: true };
            }

            currentProviderMode = 'byok';
            return { success: true };
        } catch (error) {
            console.error('Error closing session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-current-session', async event => {
        try {
            return { success: true, data: getCurrentSessionData() };
        } catch (error) {
            console.error('Error getting current session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-new-session', async event => {
        try {
            initializeNewSession();
            return { success: true, sessionId: currentSessionId };
        } catch (error) {
            console.error('Error starting new session:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    sendToRenderer,
    initializeNewSession,
    saveConversationTurn,
    getCurrentSessionData,
    killExistingSystemAudioDump,
    startMacOSAudioCapture,
    convertStereoToMono,
    stopMacOSAudioCapture,
    sendImageToOpenAI,
    setupAiIpcHandlers,
};
