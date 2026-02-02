import { GoogleGenerativeAI } from '@google/generative-ai';
import * as fs from 'fs';
import * as path from 'path';

export class GeminiLiveService {
    private genAI: GoogleGenerativeAI;
    private model: any;
    private session: any = null;
    private transcripts: Array<{ timestamp: Date; text: string; speaker?: string }> = [];
    private meetingId: string = '';

    constructor() {
        this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
        // Use Gemini 2.0 Flash for live audio
        this.model = this.genAI.getGenerativeModel({
            model: 'gemini-2.0-flash-exp',
        });
    }

    /**
     * Start a live transcription session
     */
    async startSession(meetingId: string): Promise<void> {
        this.meetingId = meetingId;
        this.transcripts = [];

        console.log('[Gemini] Starting live transcription session...');

        try {
            // Initialize live session with audio input
            this.session = await this.model.startChat({
                generationConfig: {
                    temperature: 0.3,
                    topP: 0.95,
                    topK: 40,
                },
                systemInstruction: `You are a meeting transcription assistant. Your job is to:
1. Transcribe all speech accurately
2. Identify different speakers when possible
3. Maintain conversation flow
4. Note important points and action items

Format your responses as:
[Speaker Name/Number]: [What they said]

Be concise and accurate.`
            });

            console.log('[Gemini] ✅ Live session started');
        } catch (error: any) {
            console.error('[Gemini] ❌ Failed to start session:', error.message);
            throw error;
        }
    }

    /**
     * Send audio chunk to Gemini for transcription
     * @param audioData Base64 encoded audio data (16-bit PCM, 16kHz)
     */
    async sendAudioChunk(audioData: string): Promise<void> {
        if (!this.session) {
            console.warn('[Gemini] No active session, skipping audio chunk');
            return;
        }

        try {
            // Send audio to Gemini
            const result = await this.session.sendMessage([
                {
                    inlineData: {
                        mimeType: 'audio/pcm',
                        data: audioData
                    }
                }
            ]);

            const response = result.response;
            const text = response.text();

            if (text && text.trim().length > 0) {
                const transcript = {
                    timestamp: new Date(),
                    text: text.trim(),
                    speaker: this.extractSpeaker(text)
                };

                this.transcripts.push(transcript);
                console.log(`[Gemini] Transcript: ${text.substring(0, 100)}...`);
            }
        } catch (error: any) {
            console.error('[Gemini] Error processing audio chunk:', error.message);
        }
    }

    /**
     * Extract speaker name from transcript text
     */
    private extractSpeaker(text: string): string | undefined {
        const match = text.match(/^\[([^\]]+)\]:/);
        return match ? match[1] : undefined;
    }

    /**
     * Get all transcripts from the session
     */
    getTranscripts(): Array<{ timestamp: Date; text: string; speaker?: string }> {
        return this.transcripts;
    }

    /**
     * Generate meeting summary
     */
    async generateSummary(): Promise<{
        summary: string;
        actionItems: string[];
        keyPoints: string[];
    }> {
        if (this.transcripts.length === 0) {
            return {
                summary: 'No transcripts available',
                actionItems: [],
                keyPoints: []
            };
        }

        console.log('[Gemini] Generating meeting summary...');

        try {
            const fullTranscript = this.transcripts
                .map(t => `[${t.timestamp.toISOString()}] ${t.text}`)
                .join('\n');

            const prompt = `Based on the following meeting transcript, provide:
1. A concise summary (2-3 sentences)
2. Action items (bullet points)
3. Key points discussed (bullet points)

Transcript:
${fullTranscript}

Format your response as JSON:
{
  "summary": "...",
  "actionItems": ["...", "..."],
  "keyPoints": ["...", "..."]
}`;

            const result = await this.model.generateContent(prompt);
            const response = result.response;
            const text = response.text();

            // Extract JSON from response
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const summary = JSON.parse(jsonMatch[0]);
                console.log('[Gemini] ✅ Summary generated');
                return summary;
            }

            throw new Error('Failed to parse summary response');
        } catch (error: any) {
            console.error('[Gemini] ❌ Error generating summary:', error.message);
            return {
                summary: 'Error generating summary',
                actionItems: [],
                keyPoints: []
            };
        }
    }

    /**
     * Save transcripts to file
     */
    async saveTranscripts(): Promise<string> {
        const uploadDir = path.join(__dirname, '../uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        const fileName = `transcript-${this.meetingId}-${Date.now()}.json`;
        const filePath = path.join(uploadDir, fileName);

        const data = {
            meetingId: this.meetingId,
            transcripts: this.transcripts,
            generatedAt: new Date().toISOString()
        };

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`[Gemini] Transcripts saved to ${filePath}`);

        return filePath;
    }

    /**
     * End the session
     */
    async endSession(): Promise<void> {
        console.log('[Gemini] Ending transcription session...');

        // Save transcripts
        if (this.transcripts.length > 0) {
            await this.saveTranscripts();
        }

        this.session = null;
        console.log('[Gemini] ✅ Session ended');
    }
}
