const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY must be provided through the process environment');

const response = await fetch('https://api.openai.com/v1/models', {
  headers: { authorization: 'Bearer ' + apiKey },
});
if (!response.ok) throw new Error('model availability check failed: HTTP ' + response.status + ' ' + response.statusText);
const result = await response.json();
const available = new Set((result.data || []).map((model) => model.id));
const required = ['gpt-4o-mini-tts', 'whisper-1'];
for (const model of required) console.log(model + ': ' + (available.has(model) ? 'available' : 'not listed'));
if (required.some((model) => !available.has(model))) {
  throw new Error('configured speech/transcription model is not listed for this account');
}
