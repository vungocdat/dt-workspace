import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

async function main() {
  const args = process.argv.slice(2);
  const usernameIdx = args.indexOf('--username');
  const passwordIdx = args.indexOf('--password');

  if (usernameIdx === -1 || passwordIdx === -1 || !args[usernameIdx + 1] || !args[passwordIdx + 1]) {
    console.error('Usage: npx tsx scripts/setup.ts --username <user> --password <pass>');
    process.exit(1);
  }

  const username = args[usernameIdx + 1];
  const password = args[passwordIdx + 1];

  const hash = await bcrypt.hash(password, 12);
  const secret = randomBytes(16).toString('hex'); // 32 hex chars

  console.log('\nAdd these to your .env file:\n');
  console.log(`KB_USERNAME=${username}`);
  console.log(`KB_PASSWORD_HASH=${hash}`);
  console.log(`SESSION_SECRET=${secret}`);
  console.log(`PORT=3000`);
  console.log(`DATABASE_URL=postgres://dt_workspace:<password>@localhost:5432/dt_workspace`);
  console.log(`NODE_ENV=development`);
}

main();
