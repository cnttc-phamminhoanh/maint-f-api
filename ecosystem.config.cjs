module.exports = {
  apps: [
    {
      name: 'maint-f-api',
      script: './src/index.js',
      cwd: '/home/germton/germton_services/maint-f-api',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production'
      },
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/germton/.pm2/logs/maint-f-api-error.log',
      out_file: '/home/germton/.pm2/logs/maint-f-api-out.log',
      merge_logs: true,
    }
  ]
};
