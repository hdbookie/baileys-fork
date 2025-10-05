import makeWASocket, {
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState
} from './src'
import { Boom } from '@hapi/boom'
import P from 'pino'

const logger = P({
	level: "silent", // Silence all Baileys logs for clean output
})

async function testPairingCode() {
	// Get phone number from command line argument
	const phoneNumber = process.argv[2]

	if (!phoneNumber) {
		console.error('Usage: tsx test-pairing.ts <phone-number>')
		console.error('Example: tsx test-pairing.ts 5521989974782')
		process.exit(1)
	}

	console.log(`Testing pairing code authentication for ${phoneNumber}`)

	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	const { version, isLatest } = await fetchLatestBaileysVersion()

	console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,
		logger,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		printQRInTerminal: false,
	})

	sock.ev.on('connection.update', async (update) => {
		const { connection, lastDisconnect } = update

		console.log('Connection update:', { connection, lastDisconnect: lastDisconnect?.error?.message })

		if (connection === 'close') {
			const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode

			// During pairing flow, a 401 is expected - keep reconnecting until paired
			if (statusCode === DisconnectReason.loggedOut && !sock.authState.creds.registered) {
				console.log('⏳ Waiting for pairing code to be entered... reconnecting in 3s')
				setTimeout(() => testPairingCode(), 3000)
			} else if (statusCode === DisconnectReason.loggedOut) {
				console.log('Logged out, exiting')
				process.exit(0)
			} else {
				console.log('Connection closed, reconnecting...')
				setTimeout(() => testPairingCode(), 2000)
			}
		} else if (connection === 'open') {
			console.log('✅ Successfully connected!')
			console.log('Auth state:', {
				registered: sock.authState.creds.registered,
				me: sock.authState.creds.me
			})
		}
	})

	sock.ev.on('creds.update', saveCreds)

	// Request pairing code if not registered AND no pairing code exists yet
	if (!sock.authState.creds.registered && !sock.authState.creds.pairingCode) {
		console.log('Requesting pairing code...')
		try {
			const code = await sock.requestPairingCode(phoneNumber)
			console.log('\n🔑 PAIRING CODE:', code)
			console.log('\nSteps:')
			console.log('1. Open WhatsApp on your phone')
			console.log('2. Go to Settings > Linked Devices')
			console.log('3. Tap "Link a Device"')
			console.log('4. Choose "Link with phone number instead"')
			console.log('5. Enter the pairing code above')
			console.log('\nWaiting for connection...\n')
		} catch (error) {
			console.error('Error requesting pairing code:', error)
			process.exit(1)
		}
	} else if (sock.authState.creds.pairingCode && !sock.authState.creds.registered) {
		console.log('⏳ Pairing code already generated:', sock.authState.creds.pairingCode)
		console.log('Waiting for you to enter the code on your phone...')
	} else {
		console.log('Already registered, attempting to connect...')
	}
}

testPairingCode().catch(console.error)
