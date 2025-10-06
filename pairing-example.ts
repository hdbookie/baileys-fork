import makeWASocket, {
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
	WASocket
} from './src'
import { Boom } from '@hapi/boom'
import P from 'pino'

/**
 * Example of how to use pairing code authentication in your application
 */

// Configure logger - use 'silent' for production, 'info' for debugging
const logger = P({ level: 'silent' })

interface ConnectionConfig {
	phoneNumber: string
	authDir?: string
	onPairingCode?: (code: string) => void
	onConnected?: (sock: WASocket) => void
	onDisconnected?: (reason: string) => void
	onMessage?: (message: any) => void
}

export async function connectWithPairingCode(config: ConnectionConfig): Promise<WASocket> {
	const {
		phoneNumber,
		authDir = 'baileys_auth_info',
		onPairingCode,
		onConnected,
		onDisconnected,
		onMessage
	} = config

	const { state, saveCreds } = await useMultiFileAuthState(authDir)
	const { version } = await fetchLatestBaileysVersion()

	const sock = makeWASocket({
		version,
		logger,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		printQRInTerminal: false,
		// Add any other socket options you need
		getMessage: async (key) => {
			// Implement message retrieval logic if needed
			return undefined
		}
	})

	// Handle connection updates
	sock.ev.on('connection.update', async (update) => {
		const { connection, lastDisconnect, qr } = update

		console.log('Connection update:', { connection, statusCode: (lastDisconnect?.error as Boom)?.output?.statusCode, registered: sock.authState.creds.registered })

		if (connection === 'close') {
			const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode

			// During pairing flow, a 401 is expected - keep reconnecting until paired
			if (statusCode === DisconnectReason.loggedOut && !sock.authState.creds.registered) {
				console.log('⏳ Waiting for pairing code to be entered... reconnecting in 3s')
				setTimeout(() => connectWithPairingCode(config), 3000)
			} else if (statusCode === DisconnectReason.loggedOut) {
				console.log('Logged out')
				onDisconnected?.('logged_out')
			} else {
				console.log('Connection closed, reconnecting...')
				setTimeout(() => connectWithPairingCode(config), 2000)
			}
		} else if (connection === 'open') {
			console.log('✅ Connected to WhatsApp!')
			onConnected?.(sock)
		}
	})

	// Save credentials when updated
	sock.ev.on('creds.update', saveCreds)

	// Handle incoming messages
	sock.ev.on('messages.upsert', async ({ messages, type }) => {
		if (type === 'notify') {
			for (const message of messages) {
				onMessage?.(message)
			}
		}
	})

	// Request pairing code if not registered
	if (!sock.authState.creds.registered && !sock.authState.creds.pairingCode) {
		console.log('Requesting pairing code...')
		try {
			const code = await sock.requestPairingCode(phoneNumber)
			console.log('\n🔑 PAIRING CODE:', code)
			onPairingCode?.(code)
		} catch (error) {
			console.error('Error requesting pairing code:', error)
			throw error
		}
	} else if (sock.authState.creds.pairingCode && !sock.authState.creds.registered) {
		console.log('⏳ Pairing code already generated:', sock.authState.creds.pairingCode)
		console.log('Waiting for you to enter the code on your phone...')
		onPairingCode?.(sock.authState.creds.pairingCode)
	}

	return sock
}

// Example usage
const phoneNumber = process.argv[2]

if (!phoneNumber) {
	console.error('Usage: tsx pairing-example.ts <phone-number>')
	console.error('Example: tsx pairing-example.ts 5521989974782')
	process.exit(1)
}

connectWithPairingCode({
	phoneNumber,
	authDir: 'baileys_auth_info',
	onPairingCode: (code) => {
		console.log('Pairing code callback:', code)
		// Send this code to your user via your app's UI
	},
	onConnected: (sock) => {
		console.log('Connected! User:', sock.user?.id)
		// Initialize your app logic here
	},
	onDisconnected: (reason) => {
		console.log('Disconnected:', reason)
		// Handle disconnection in your app
	},
	onMessage: (message) => {
		console.log('New message:', message)
		// Handle incoming messages
	}
}).catch(console.error)
