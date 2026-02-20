import express from 'express';
const router = express.Router();

// Ruta Raíz
router.get('/', (req, res) => {
    res.send('<h1>Servidor de WhatsApp Activo</h1>');
});

// SOLUCIÓN AL ERROR /login
router.get('/login', (req, res) => {
    const getQR = req.app.get('qrCode');
    const qrImage = getQR();

    if (qrImage) {
        res.send(`
            <div style="text-align:center;font-family:sans-serif;margin-top:50px;">
                <h2>Escanea el QR para conectar</h2>
                <img src="${qrImage}" style="border:5px solid #25D366; border-radius:10px;"/>
                <p>Recarga la página si el código expira.</p>
                <script>setTimeout(() => location.reload(), 20000);</script>
            </div>
        `);
    } else {
        res.send('<h2>No hay QR disponible. Revisa si ya estás conectado o espera unos segundos.</h2>');
    }
});

export default router;
