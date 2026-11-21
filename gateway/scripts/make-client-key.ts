// Run with `npm run make-client-key -- <name> <role>`. Node strips the types; nothing is built.
// Prints a new key ONCE and the registry entry for it. It never writes a file.
import { HASH_PATTERN, NAME_PATTERN, generateKey, registryEntry } from '../src/auth/client-key.ts';

const ROLES = ['submitter', 'reviewer'];
const [name, role] = process.argv.slice(2);

if (!name || !role || !NAME_PATTERN.test(name) || !ROLES.includes(role)) {
  console.error('Usage: npm run make-client-key -- <name> <role>');
  console.error('  name: 1 to 40 characters of a-z, 0-9 and -');
  console.error('  role: submitter | reviewer');
  process.exit(1);
}

const key = generateKey();
const entry = registryEntry(name, role, key);
if (!HASH_PATTERN.test(entry.key_sha256)) throw new Error('internal error: bad hash');

console.log(`Client "${name}" (${role})`);
console.log('');
console.log('API key (shown ONCE, store it now in a password manager; it cannot be recovered):');
console.log(`  ${key}`);
console.log('');
console.log('Registry entry. Add it to the JSON array in GATEWAY_CLIENTS (gateway/.env):');
console.log(`  ${JSON.stringify(entry)}`);
console.log('');
console.log('The gateway stores only the hash. Restart it after changing GATEWAY_CLIENTS.');
