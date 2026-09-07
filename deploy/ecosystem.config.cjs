module.exports = {
  apps: [
    {
      name: "jhc-netops-runner",
      script: "deploy/run-runner.sh",
      cwd: "/var/www/jhc/jhc_noc/current",
      interpreter: "/usr/bin/bash",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
    },
    {
      name: "jhc-netops-frontend",
      script: "deploy/run-frontend.sh",
      cwd: "/var/www/jhc/jhc_noc/current",
      interpreter: "/usr/bin/bash",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
    },
    {
      name: "jhc-netops-backend",
      script: "deploy/run-backend.sh",
      cwd: "/var/www/jhc/jhc_noc/current",
      interpreter: "/usr/bin/bash",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
    },
  ],
};
