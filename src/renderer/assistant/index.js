// eslint-disable-next-line
import { ipcRenderer, remote } from 'electron';
import { EventEmitter } from 'events';
import GoogleAssistant from 'google-assistant';

import Configuration from '@/config';
import store from '@/store';

import Commands from '@/commands';
import TextFilters from './text-filters';

import Player from './player';
import Microphone from './microphone';

export default class Assistant extends EventEmitter {
	constructor() {
		super();

		/** Audio player for Google Assistant responses */
		this.player = new Player();

		/** Microphone class build to transform the browser microphone to an output that's ready for google. */
		this.microphone = new Microphone(Configuration.assistant.audio.sampleRateIn);

		/** Processor for commands */
		this.commands = new Commands();

		/** The assistant library we use to process everything and connect to Google */
		this.assistant = undefined;

		this.responseWindow = undefined;

		ipcRenderer.on('message', (event, message) => {
			console.log('Message from childeren:', message, event);
			if (message.query) {
				this.assist(message.query.queryText);
			}
		});

		this.startConversation = (conversation) => {
			conversation.on('audio-data', (data) => {
				// console.log('incoming audio buffer...', data);
				this.player.appendBuffer(Buffer.from(data));
			});

			conversation.on('end-of-utterance', () => {
				console.info('End of utterance.');
			});

			conversation.on('device-action', (data) => {
				console.log('Device action: ', data);
			});

			conversation.on('speech-results', (results) => {
				console.log('Speech results...', results);
			});

			conversation.on('response', (text) => {
				console.log('Response: ', text);
			});

			conversation.on('screen-data', (data) => {
				console.log('data screen: ', data);
				switch (data.format) {
				case 'HTML':
					this.updateResponseWindow(data.data.toString());
					break;
				default:
					console.log('Error: unknown data format.');
				}
			});
		};

		/** Text-processor for incoming messages from Google */
		this.textFilters = new TextFilters();

		/** Registers if we need to follow on the input we've given */
		this.followOn = false;

		/** Store if current action is a command */
		this.command = false;

		this.player.on('ready', () => console.log('Audio player ready...'));

		/** Registering events for registered services */

		/** Event for when the assistant stopped talking
		this.player.on('waiting', () => this.onAssistantFinishedTalking());
		// Event for when we receive input from the microphone, sending it to the Google Assistant.
		this.microphone.on('data', data => this.assistant.writeAudio(data));
		// Event for when the microphone is ready with registering.
		this.microphone.on('ready', () => console.log('Microphone ready...'));
		// Event for when the card processor nodes have been loaded.
		this.textFilters.on('ready', () => console.log('cards ready...'));
		this.player.on('ready', () => console.log('Audio player ready...')); * */
	}

	/** Triggers when the audio player has stopped playing audio. */
	onAssistantFinishedTalking() {
		console.log('Google Assistant audio stopped.');
		if (this.followOn) {
			console.log('Follow on required.');
			this.followOn = false;
			this.reset();
		}
	}

	updateResponseWindow(html) {
		this.emit('responseHtml', html);
	}

	/** Stops the assistant and starts directly a new assist / conversation */
	reset() {
		this.stop();
		this.assist();
	}

	/**
	 * Let's the Google Assistant say a given sentence.
	 *
	 * @param string sentence
	 * @param int Delay in seconds
	 */
	say(sentence, delay = 0, silent = false) {
		setTimeout(() => {
			if (this.state === 0) this.stop();
			if (sentence) {
				this.addMessage(sentence, 'incoming');
				if (!silent) {
					this.assistant.say(sentence);
				} else {
					this.emit('ready');
				}
			}
		}, 1000 * delay);
	}

	ask(question) {
		return new Promise((resolve) => {
			console.log('starting ask....', question);
			if (this.state === 0) this.stop();
			if (question) {
				this.addMessage(question, 'incoming', true);
				this.assistant.once('end', () => {
					console.log('question ended.');
					this.player.once('waiting', () => {
						console.log('waiting for response...');
						this.assistant.removeAllListeners('speech-results').on('speech-results', (results) => {
							if (results && results.length) {
								console.info('ASK - Speech Results', results);
								if (results.length === 1 && results[0].stability === 1) {
									this.addMessage(results[0].transcript, 'outgoing');
									Window.Store.state.assistant.speechTextBuffer = [];
									this.microphone.enabled = false;
									console.log('executing response after session.');
									this.assistant.once('end', () => {
										console.log('ready for response...');
										resolve(results[0].transcript);
									});
									this.forceStop();
								} else {
									Window.Store.state.assistant.speechTextBuffer = results;
								}
							}
						});
						this.assist();
					});
				});
				this.assistant.say(question);
			}
		});
	}

	/**
	 * Adds a message to the global assistant store to display in the UI
	 *
	 * @param string text
	 * @param string type
	 */
	addMessage(text, type, followup = false) {
		this.command = null;
		const message = this.processMessage(text, type, followup);
		store.commit('addMessage', message);
		return message;
	}

	// [TODO]: Move processing of messages to another class?
	/**
	 * Processes & formats an incoming message from the assistant into a proper output.
	 *
	 * @param {*} text
	 * @param {*} type
	 */
	processMessage(text, type, followup = false) {
		const message = { text, type, followup };

		if (type !== 'incoming' || followup) {
			return message;
		}

		const returnMessage = this.textFilters.getMessage(text);
		console.log(returnMessage);
		return returnMessage;
	}

	playPing() {
		this.player.playPing();
	}

	/**
	 * Sends a request to Google Assistant to start audio streaming
	 * or for the text input given in the arguemnt
	 *
	 * @param {*} inputQuery
	 */
	assist(inputQuery = null) {
		// this.player.reset();
		if (inputQuery) {
			this.emit('waiting');
			this.addMessage(inputQuery, 'outgoing', true);
			if (!this.runCommand(inputQuery)) {
				Configuration.assistant.textQuery = inputQuery;
				this.assistant.start(Configuration.assistant, this.startConversation);
			}
		} else {
			this.emit('loading');
			Configuration.assistant.textQuery = undefined;
			this.assistant.start(Configuration.assistant, this.startConversation);
		}
	}

	/**
	 * Sets the mini mode for the assistant.
	 * @param {*} enabled
	 */
	setMiniMode(enabled) {
		if (enabled && !this.miniMode) {
			this.miniMode = true;
			ipcRenderer.send('mini-mode', true);
			this.emit('mini-mode', true);
		} else if (!enabled && this.miniMode) {
			this.miniMode = false;
			ipcRenderer.send('mini-mode', false);
			this.emit('mini-mode', false);
		}
	}

	/**
	 * Run's a command based on the input text query
	 * @param {*} textQuery
	 * @param {*} queueCommand Queue the command when the assistant has ended current converstion.
	 */
	runCommand(textQuery, queueCommand = false) {
		console.log('Checking if"', textQuery, '"is a command.');
		const command = this.commands.findCommand(textQuery);
		if (command) {
			console.log('Command found.', command);
			this.command = command;
			if (!queueCommand) {
				console.log('executing command directly.');
				if (Commands.run(this.command)) {
					console.log('executing command done.');
					this.emit('ready');
				}
			} else {
				console.log('executing command after session.');
				this.assistant.once('end', () => {
					console.log('ready for command...');
					if (Commands.run(this.command)) {
						console.log('command finished!');
						this.emit('ready');
					}
				});
				this.forceStop();
			}
			return true;
		}
		console.log('no command found.');
		return false;
	}

	/** Stops the microphone output and plays what's left in the buffer (if any) */
	stop() {
		this.microphone.enabled = false;
		this.player.play();
	}

	/** Force stops the assistant & audio and it's connection to Google. */
	forceStop() {
		console.log('Force stopping the assistant & players...');
		this.assistant.stop();
		this.microphone.enabled = false;
		this.player.stop();
	}

	/**
	 * Sets up the Google Assistant for Electron.
	 * @param {*} OAuth2Client
	 */
	authenticate() {
		this.assistant = new GoogleAssistant(Configuration.auth);
		this.assistant.on('ready', () => {
			this.emit('ready');
		});

		this.assistant.on('error', (error) => {
			console.log('Assistant Error:', error);
		});
	}

	onSpeechResults(results) {
		console.log('Speech Results:', results);
		if (results && results.length) {
			console.info('Speech Results', results);
			if (results.length === 1 && results[0].stability === 1) {
				this.addMessage(results[0].transcript, 'outgoing', false);
				Window.Store.state.assistant.speechTextBuffer = [];
				this.runCommand(results[0].transcript, true);
				this.microphone.enabled = false;
				this.emit('waiting');
			} else {
				Window.Store.state.assistant.speechTextBuffer = results;
			}
			this.emit('new-text');
		}
	}
}
