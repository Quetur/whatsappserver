// este archivo me lo recomiendan para que pm2 no reinicie continuamente cuando detecte 
//      que auth_token cambia

module.exports = {
  apps: [{
    name: "whatsapp-api",
    script: "./index.js",
    watch: true,
    ignore_watch: ["node_modules", "auth_tokens"] // Agrega esto
  }]
}
