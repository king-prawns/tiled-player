import {Compiler, DevServer, rspack} from '@rspack/core';
import {RspackDevServer} from '@rspack/dev-server';
import chalk from 'chalk';

import devConfig from './rspack.dev.conf';

const {log} = console;
const SERVER_PORT: string = '8800';

const isProd: boolean = process.argv.includes('--prod');

const compiler: Compiler = rspack(devConfig);

if (isProd) {
  log(chalk.cyan('Building to sandbox/dist folder...'));
  compiler.run((err: Error | null) => {
    if (err) {
      log(chalk.red('Build failed:', err));
    } else {
      log(chalk.green('Build completed 🎉'));
    }
  });
} else {
  log(chalk.cyan('Starting dev server...'));

  const options: DevServer = {
    client: {
      overlay: false
    },
    allowedHosts: 'all',
    port: SERVER_PORT,
    compress: true,
    server: {
      type: 'http'
    }
  };

  const server: RspackDevServer = new RspackDevServer(options, compiler!);
  server
    .start()
    .then(() => {
      log(chalk.green(`Dev server is running: http://localhost:${SERVER_PORT}`));
    })
    .catch((err: unknown) => {
      log(chalk.red('Failed to start dev server:', err));
    });
}
