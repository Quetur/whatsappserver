import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import pino from 'pino';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import cookieParser from 'cookie-parser';
import { v4 as uuidv4 } from 'uuid';
import makeWASocket, { 
    useMultiFileAuthState, 
    Browsers, 
    DisconnectReason,
    fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';

// Configuración de rutas para ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const httpServer = createServer(app);

// ID de sesión único (se genera cada vez que el servidor inicia)
const SESSION_ID = uuidv4(); 

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Para leer el formulario de login
app.use(cookieParser());

// --- LÓGICA DE AUTENTICACIÓN POR COOKIES ---

const checkAuth = (req, res, next) => {
    // Si la cookie coincide con el ID de sesión del servidor, permitir acceso
    if (req.cookies.auth_session === SESSION_ID) {
        return next();
    }
    // Si no está autenticado, redirigir al login (excepto si ya está en /login)
    if (req.path === '/login') return next();
    res.redirect('/login');
};

// Ruta de Login (Formulario)
app.get('/login', (req, res) => {
    const errorMsg = req.query.error ? '<p style="color:red; margin-bottom:10px;">Credenciales incorrectas</p>' : '';
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Login - WhatsApp Panel</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f0f2f5; margin: 0; }
                form { background: white; padding: 40px; border-radius: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); width: 300px; text-align: center; }
                input { width: 100%; padding: 12px; margin: 8px 0; border: 1px solid #ddd; border-radius: 5px; box-sizing: border-box; }
                button { width: 100%; padding: 12px; background: #25d366; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; font-size: 16px; }
                button:hover { background: #128c7e; }
                h2 { color: #075e54; margin-bottom: 20px; }
            </style>
        </head>
        <body>
            <form action="/login" method="POST">
                <h2>WhatsApp Panel</h2>
                ${errorMsg}
                <input type="text" name="user" placeholder="Usuario" required>
                <input type="password" name="pass" placeholder="Contraseña" required>
                <button type="submit">Ingresar</button>
            </form>
        </body>
        </html>
    `);
});

// Procesar el Login
app.post('/login', (req, res) => {
    const { user, pass } = req.body;
    const { ADMIN_USER, ADMIN_PASS } = process.env;

    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        // Guardamos la sesión en una cookie segura
        res.cookie('auth_session', SESSION_ID, { httpOnly: true, sameSite: 'lax' });
        return res.redirect('/');
    }
    res.redirect('/login?error=1');
});

// Logout Real (Borra la cookie)
app.get('/logout', (req, res) => {
    res.clearCookie('auth_session');
    res.redirect('/login');
});

// --- PROTEGER RUTAS DEL PANEL ---
app.use('/api/status', checkAuth);
app.get('/', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// Servir archivos estáticos después de la protección
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// --- LÓGICA DE WHATSAPP (Baileys) ---
let sock;
let isConnected = false;
let phoneNumber = null;
let qrImageBase64 = null;
const logger = pino({ level: 'silent' });

async function conectarWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_tokens');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: logger,
        browser: Browsers.macOS('Chrome'),
        printQRInTerminal: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                qrImageBase64 = await QRCode.toDataURL(qr);
                qrcodeTerminal.generate(qr, { small: true });
                console.log('📷 Nuevo QR generado. Inicie sesión para escanear.');
            } catch (err) {
                console.error('Error generando QR:', err);
            }
        }

        if (connection === 'open') {
            isConnected = true;
            qrImageBase64 = null;
            phoneNumber = sock.authState.creds.me.id.split(':')[0];
            console.log(`✅ Conectado como: ${phoneNumber}`);
        } else if (connection === 'close') {
            isConnected = false;
            qrImageBase64 = null;
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                conectarWhatsApp();
            }
        }
    });
}

// Endpoint de estado protegido
app.get('/api/status', (req, res) => {
    res.json({ isConnected, qr: qrImageBase64, number: phoneNumber });
});

// Endpoint para enviar mensajes (Seguridad vía API_KEY)
app.post('/enviar-pedido', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const idBasededatos = req.body.idBasededatos; 
    console.log('📦 Pedido recibido para ID de Base de Datos:', idBasededatos);
    const expectedToken = `Bearer ${process.env.API_KEY}`;

    if (!authHeader || authHeader.trim() !== expectedToken.trim()) {
        return res.status(401).json({ error: 'No autorizado' });
    }

    const { telefono, mensaje } = req.body;
    if (!isConnected || !sock) return res.status(503).json({ error: 'WhatsApp no conectado' });

    try {
        const numeroLimpio = telefono.replace(/\D/g, '');
        let [result] = await sock.onWhatsApp(numeroLimpio);

        // Lógica para Argentina (prefijo 9)
        if (!result || !result.exists) {
            const varianteSin9 = numeroLimpio.replace('549', '54');
            [result] = await sock.onWhatsApp(varianteSin9);
        }

        if (result && result.exists) {
            // 1. ENVIAR MENSAJE AL DESTINATARIO (Entrada)
            const enviadoDestino = await sock.sendMessage(result.jid, { text: mensaje });

            // 2. ENVIAR NOTIFICACIÓN AL ORIGEN (Salida/Confirmación)
            // Usamos sock.authState.creds.me.id para enviarte el mensaje a ti mismo
            const miJid = sock.authState.creds.me.id.split(':')[0] + '@s.whatsapp.net';
            await sock.sendMessage(miJid, { 
                text: `✅ *Pedido Enviado*\n\n*A:* ${numeroLimpio}\n*Mensaje:* ${mensaje}` 
            });

            return res.status(200).json({ 
                success: true, 
                messageId: enviadoDestino.key.id 
            });
        }
        
        res.status(404).json({ success: false, error: 'El número no tiene WhatsApp' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`🚀 Panel seguro activo: http://localhost:${PORT}`);
    conectarWhatsApp();
});
