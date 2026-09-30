module.exports = {
  apps: [
    {
      name: 'maint-api',
      script: './src/index.js',
      cwd: '/home/germton/germton_services/maint-f-api',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
