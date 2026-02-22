import fs from 'fs'; 
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

// ID de sesión único
const SESSION_ID = uuidv4(); 

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// --- LÓGICA DE AUTENTICACIÓN POR COOKIES ---
const checkAuth = (req, res, next) => {
    if (req.cookies.auth_session === SESSION_ID) {
        return next();
    }
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

app.post('/login', (req, res) => {
    const { user, pass } = req.body;
    const { ADMIN_USER, ADMIN_PASS } = process.env;
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        res.cookie('auth_session', SESSION_ID, { httpOnly: true, sameSite: 'lax' });
        return res.redirect('/');
    }
    res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
    res.clearCookie('auth_session');
    res.redirect('/login');
});

// --- LÓGICA DE WHATSAPP (Baileys) ---
// --- LÓGICA DE WHATSAPP ---
let sock;
let isConnected = false;
let phoneNumber = null;
let qrImageBase64 = null;
const logger = pino({ level: 'silent' });

async function conectarWhatsApp() {
    // Si ya hay un socket activo, no crear otro
    if (sock) {
        try { sock.ev.removeAllListeners(); } catch(e) {}
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_tokens');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: logger,
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
        printQRInTerminal: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrImageBase64 = await QRCode.toDataURL(qr);
            console.log('📷 Nuevo QR generado.');
        }

        if (connection === 'open') {
            isConnected = true;
            qrImageBase64 = null;
            phoneNumber = sock.authState.creds.me.id.split(':')[0];
            console.log(`✅ Conectado como: ${phoneNumber}`);
        } else if (connection === 'close') {
            isConnected = false;
            qrImageBase64 = null;
            
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log('❌ Conexión cerrada. Razón:', statusCode);

            // Solo reconectar si NO fue un cierre de sesión manual
            if (shouldReconnect) {
                console.log('🔄 Intentando reconectar automáticamente...');
                conectarWhatsApp();
            } else {
                console.log('🚪 Sesión terminada. Esperando nueva vinculación.');
            }
        }
    });
}
// --- API ENDPOINTS PROTEGIDOS ---

// Estado de conexión
app.get('/api/status', checkAuth, (req, res) => {
    res.json({ isConnected, qr: qrImageBase64, number: phoneNumber });
});

// Generar Código de Emparejamiento (8 dígitos)
app.post('/api/get-pairing-code', checkAuth, async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Número requerido' });
    if (isConnected) return res.status(400).json({ error: 'Ya estás conectado' });

    try {
        // El número debe ir sin '+' y sin espacios
        const code = await sock.requestPairingCode(phone.replace(/\D/g, ''));
        res.json({ code });
    } catch (err) {
        console.error('Error pairing code:', err);
        res.status(500).json({ error: 'No se pudo generar el código' });
    }
});

// Endpoint para cerrar sesión de WhatsApp y borrar tokens
app.post('/api/logout-whatsapp', checkAuth, async (req, res) => {
    try {
        console.log('🧹 Iniciando limpieza de sesión...');
        
        // 1. Resetear variables de estado inmediatamente
        isConnected = false;
        qrImageBase64 = null;
        phoneNumber = null;

        // 2. Cerrar el socket si existe
        if (sock) {
            sock.ev.removeAllListeners(); // Evitar que dispare eventos de reconexión
            await sock.logout().catch(() => {});
            sock.end();
            sock = null;
        }

        // 3. Borrar físicamente la carpeta de tokens
        const authPath = path.join(__dirname, 'auth_tokens');
        if (fs.existsSync(authPath)) {
            // Reintento de borrado por si archivos están bloqueados
            setTimeout(() => {
                try {
                    fs.rmSync(authPath, { recursive: true, force: true });
                    console.log('🗑️ Carpeta auth_tokens eliminada.');
                } catch (e) {
                    console.error('Error al borrar carpeta:', e.message);
                }
            }, 500);
        }

        res.json({ success: true });

        // 4. Iniciar una conexión totalmente limpia después de 2 segundos
        setTimeout(() => {
            conectarWhatsApp();
        }, 2000);

    } catch (err) {
        console.error('Error en logout:', err);
        res.status(500).json({ error: 'Error al desvincular' });
    }
});




// Enviar pedidos (Seguridad vía API_KEY para sistemas externos)
app.post('/enviar-pedido', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const expectedToken = `Bearer ${process.env.API_KEY}`;

    if (!authHeader || authHeader.trim() !== expectedToken.trim()) {
        return res.status(401).json({ error: 'No autorizado' });
    }

    const { telefono, mensaje } = req.body;
    if (!isConnected || !sock) return res.status(503).json({ error: 'WhatsApp no conectado' });

    try {
        const numeroLimpio = telefono.replace(/\D/g, '');
        let [result] = await sock.onWhatsApp(numeroLimpio);

        if (!result || !result.exists) {
            const varianteSin9 = numeroLimpio.replace('549', '54');
            [result] = await sock.onWhatsApp(varianteSin9);
        }

        if (result && result.exists) {
            const enviadoDestino = await sock.sendMessage(result.jid, { text: mensaje });
            const miJid = sock.authState.creds.me.id.split(':')[0] + '@s.whatsapp.net';
            await sock.sendMessage(miJid, { 
                text: `✅ *Pedido Enviado*\n\n*A:* ${numeroLimpio}\n*Mensaje:* ${mensaje}` 
            });

            return res.status(200).json({ success: true, messageId: enviadoDestino.key.id });
        }
        res.status(404).json({ success: false, error: 'El número no tiene WhatsApp' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- SERVIR FRONTEND ---
app.get('/', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`🚀 Panel activo: http://localhost:${PORT}`);
    conectarWhatsApp();
});
