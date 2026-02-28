// whatsapp.js
import { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import makeWASocket from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

let sock;
export const state = { isConnected: false, phoneNumber: null, qrImageBase64: null };
const logger = pino({ level: 'silent' });

export async function conectarWhatsApp() {
    const { state: authState, saveCreds } = await useMultiFileAuthState('auth_tokens');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: authState,
        logger,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) state.qrImageBase64 = await QRCode.toDataURL(qr);
        if (connection === 'open') {
            state.isConnected = true;
            state.qrImageBase64 = null;
            state.phoneNumber = sock.authState.creds.me.id.split(':')[0];
        } else if (connection === 'close') {
            state.isConnected = false;
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) conectarWhatsApp();
        }
    });
    return sock;
}

export const getSock = () => sock;
import fs from 'fs';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import cookieParser from 'cookie-parser';
import { v4 as uuidv4 } from 'uuid';
import { conectarWhatsApp, sock, state, SESSION_ID } from './whatsapp.js'; // Importamos la lógica modular

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// --- SEGURIDAD ---
const checkAuth = (req, res, next) => {
    if (req.cookies.auth_session === SESSION_ID) return next();
    res.redirect('/login');
};

// --- RUTAS DE NAVEGACIÓN ---
app.get('/', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));

app.post('/login', (req, res) => {
    const { user, pass } = req.body;
    if (user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASS) {
        res.cookie('auth_session', SESSION_ID, { httpOnly: true, sameSite: 'lax' });
        return res.redirect('/');
    }
    res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
    res.clearCookie('auth_session');
    res.redirect('/login');
});

// --- API WHATSAPP ---
app.get('/api/status', checkAuth, (req, res) => res.json(state));

app.post('/api/get-pairing-code', checkAuth, async (req, res) => {
    const { phone } = req.body;
    if (!phone || state.isConnected) return res.status(400).json({ error: 'Estado no apto' });
    try {
        const code = await sock.requestPairingCode(phone.replace(/\D/g, ''));
        res.json({ code });
    } catch (err) { res.status(500).json({ error: 'Error al generar código' }); }
});

app.post('/api/logout-whatsapp', checkAuth, async (req, res) => {
    state.isConnected = false;
    if (sock) {
        sock.ev.removeAllListeners();
        await sock.logout().catch(() => {});
        sock.end();
    }
    const authPath = path.join(__dirname, 'auth_tokens');
    if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
    res.json({ success: true });
    setTimeout(() => conectarWhatsApp(), 2000);
});

// --- ENVÍO DE PEDIDOS (API EXTERNA) ---
app.post('/enviar-pedido', async (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${process.env.API_KEY}`) return res.status(401).send('No autorizado');
    if (!state.isConnected || !sock) return res.status(503).send('WhatsApp offline');

    const { telefono, mensaje } = req.body;
    try {
        const num = telefono.replace(/\D/g, '');
        let [contact] = await sock.onWhatsApp(num);
        if (!contact?.exists) [contact] = await sock.onWhatsApp(num.replace('549', '54'));
        
        if (contact?.exists) {
            await sock.sendMessage(contact.jid, { text: mensaje });
            return res.json({ success: true });
        }
        res.status(404).send('Número no registrado');
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- INICIO ---
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    conectarWhatsApp(); // Se recomienda usar la [Documentación de Baileys](https://github.com) para ajustes de conexión.
});
