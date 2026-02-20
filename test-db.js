import mysql from 'mysql2/promise';
import 'dotenv/config';

async function testConnection() {
    console.log('--- 🔍 Iniciando Prueba de Conexión ---');
    console.log(`Intentando conectar a: ${process.env.DB_HOST || '127.0.0.1'}`);
    console.log(`Usuario: ${process.env.DB_USER}`);
    console.log(`Base de Datos: ${process.env.DB_NAME}`);
    console.log('---------------------------------------');

    try {
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME,
            port: 3306,
            connectTimeout: 5000 // 5 segundos máximo
        });

        console.log('✅ ¡CONEXIÓN EXITOSA!');
        
        // Verificar si existen tablas (para ver si la DB está vacía)
        const [rows] = await connection.query('SHOW TABLES');
        console.log(`Tablas encontradas en la DB: ${rows.length}`);
        
        await connection.end();
        process.exit(0);

    } catch (error) {
        console.error('❌ ERROR DE CONEXIÓN DETECTADO:');
        
        if (error.code === 'ECONNREFUSED') {
            console.error('👉 Motivo: El servidor MySQL no está encendido o el puerto 3306 está bloqueado.');
        } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
            console.error('👉 Motivo: Usuario o Contraseña incorrectos.');
        } else if (error.code === 'ER_BAD_DB_ERROR') {
            console.error(`👉 Motivo: La base de datos "${process.env.DB_NAME}" NO EXISTE. Debes crearla en phpMyAdmin.`);
        } else {
            console.error(`👉 Código de error: ${error.code}`);
            console.error(error.message);
        }
        process.exit(1);
    }
}

testConnection();
