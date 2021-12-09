module.exports = {
  apps : [{
    name: 'odysee-livestream-player',
    cwd: './',
    script: 'server/index.js', // Start server

    // Options reference: https://pm2.io/doc/en/runtime/reference/ecosystem-file/
    args: '',
    instances: 'max',
    exec_mode: 'cluster',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      HOST: '0.0.0.0',
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 5000,
      HOST: '0.0.0.0',
    },
  }]
};
