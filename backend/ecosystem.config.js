// PM2 Ecosystem Config — AeroStrat Surveillance v2.9.0
module.exports = {
    apps: [
        {
            name: 'aerostrat',
            script: 'server.js',
            cwd: './',
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '512M',

            // Restart strategy
            restart_delay: 3000,
            max_restarts: 10,
            min_uptime: '10s',

            // Environment
            env: {
                NODE_ENV: 'production',
                PORT: 3000,
            },

            // Logging
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            error_file: './logs/pm2-error.log',
            out_file: './logs/pm2-out.log',
            merge_logs: true,
        },
    ],
};
