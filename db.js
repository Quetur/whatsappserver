// db.js
import mysql from 'mysql2/promise';
import 'dotenv/config';

// 1. Validación estricta de variables de entorno
const requiredEnv = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_PORT'];
requiredEnv.forEach(name => {
  if (!process.env[name]) {
    throw new Error(`[Error de Configuración]: Falta la variable ${name} en el archivo .env`);
  }
});

// 2. Configuración robusta para Clever Cloud
const poolConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: parseInt(process.env.DB_PORT) || 3306, 
  
  waitForConnections: true,
  connectionLimit: 10,         // Aumentado a 10 para soportar Baileys + API Express simultáneo
  connectTimeout: 30000,       // 30s: Las bases de datos en la nube a veces tardan en responder el handshake inicial
  
  ssl: {
    rejectUnauthorized: false 
  },

  // OPTIMIZACIÓN CRÍTICA PARA SESIONES BAILEYS:
  enableKeepAlive: true,       // Obligatorio para evitar "Unsupported state" por desconexión de socket SQL
  keepAliveInitialDelay: 10000, // Envía un paquete de control cada 10 segundos
  
  // Gestión de inactividad
  maxIdle: 10,                 
  idleTimeout: 60000,          // 60s: Mantenemos la conexión abierta más tiempo para evitar el ciclo abrir/cerrar
};

console.log('🔧 Conectando a Clever Cloud en:', poolConfig.host);

const pool = mysql.createPool(poolConfig);

// 3. Prueba de conexión con manejo de error específico
(async () => {
    try {
        const connection = await pool.getConnection();
        console.log('✅ [MySQL] Conexión con Clever Cloud exitosa y validada.');
        connection.release(); // Liberamos la conexión de prueba inmediatamente
    } catch (err) {
        console.error('❌ [MySQL] Error de conexión remota:', err.message);
        if (err.code === 'ETIMEDOUT') console.log('👉 Error de tiempo: Revisa el firewall de Clever Cloud.');
    }
})();

export default pool;
