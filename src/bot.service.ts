import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { launch, Page, Browser } from 'puppeteer-core';
import * as fs from 'fs';
import * as path from 'path';
import { GeminiLiveService } from './gemini-live.service';

// Add stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

export class BotService {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private geminiService: GeminiLiveService | null = null;
    private isRecording = false;
    private isLoggedIn = false; // Track login state
    private meetingId: string = '';
    private meetingStatus: 'idle' | 'joining' | 'active' | 'ended' = 'idle';

    /**
     * Log in to Google Account if credentials are provided
     */
    private async loginToGoogle(): Promise<void> {
        const email = process.env.GOOGLE_BOT_EMAIL;
        const password = process.env.GOOGLE_BOT_PASSWORD;

        console.log(`[Bot] Login check - Email: ${email ? 'SET' : 'NOT SET'}, Password: ${password ? 'SET' : 'NOT SET'}`);

        if (!email || !password) {
            console.log('[Bot] No Google credentials provided, joining as guest');
            return;
        }

        if (this.isLoggedIn) {
            console.log('[Bot] Already logged in, skipping login');
            return;
        }

        try {
            console.log('[Bot] Starting Google Account login...');
            console.log(`[Bot] Using email: ${email}`);

            // Navigate to Google login
            console.log('[Bot] Navigating to Google login page...');
            await this.page!.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle2' });
            console.log('[Bot] Reached login page');

            // Enter email
            console.log('[Bot] Waiting for email input field...');
            await this.page!.waitForSelector('input[type="email"]', { timeout: 10000 });
            console.log('[Bot] Found email field, typing email...');
            await this.page!.type('input[type="email"]', email, { delay: 100 });
            console.log('[Bot] Email entered, pressing Enter...');
            await this.page!.keyboard.press('Enter');

            // Wait for password field
            console.log('[Bot] Waiting for password field...');
            await this.page!.waitForSelector('input[type="password"]', { visible: true, timeout: 15000 });
            await new Promise(r => setTimeout(r, 2000)); // Longer pause for page to stabilize

            // Try to enter password - use evaluate as more reliable method
            console.log('[Bot] Entering password...');
            const passwordSet = await this.page!.evaluate((pwd) => {
                const pwdField = document.querySelector('input[type="password"]') as HTMLInputElement;
                if (pwdField) {
                    pwdField.value = pwd;
                    // Trigger input event to ensure React/Angular detect the change
                    pwdField.dispatchEvent(new Event('input', { bubbles: true }));
                    pwdField.dispatchEvent(new Event('change', { bubbles: true }));
                    return pwdField.value.length > 0;
                }
                return false;
            }, password);

            console.log(`[Bot] Password set successfully: ${passwordSet}`);

            if (!passwordSet) {
                throw new Error('Failed to set password in field');
            }

            // Wait a moment for the form to register the input
            await new Promise(r => setTimeout(r, 1000));

            console.log('[Bot] Pressing Enter to submit...');
            await this.page!.keyboard.press('Enter');

            // Wait for login to complete (check for Google account page or redirect)
            console.log('[Bot] Waiting for login to complete...');
            await new Promise(r => setTimeout(r, 8000)); // Longer wait for login processing

            // Take screenshot to see what happened
            const uploadDir = path.join(__dirname, '../uploads');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            await this.page!.screenshot({ path: path.join(uploadDir, 'login-debug.png') });
            console.log('[Bot] Screenshot saved to uploads/login-debug.png');

            // Check if we're logged in by looking for account indicator or checking URL
            const loginStatus = await this.page!.evaluate(() => {
                const url = window.location.href;
                const pageText = document.body.innerText.toLowerCase();

                // Check for error messages
                if (pageText.includes('wrong password') || pageText.includes('couldn\'t find your google account')) {
                    return { success: false, reason: 'Invalid credentials' };
                }

                // Check if still on login page
                if (url.includes('accounts.google.com/signin') || url.includes('accounts.google.com/v3/signin')) {
                    return { success: false, reason: 'Still on login page' };
                }

                // Check for successful login indicators
                if (url.includes('myaccount.google.com') ||
                    pageText.includes('google account') ||
                    document.querySelector('[aria-label*="google account"]')) {
                    return { success: true, reason: 'Login successful' };
                }

                return { success: false, reason: 'Unknown state', url, pageText: pageText.substring(0, 200) };
            });

            console.log('[Bot] Login status:', JSON.stringify(loginStatus));

            if (loginStatus.success) {
                console.log('[Bot] ✅ Successfully logged in to Google Account');
                this.isLoggedIn = true;
            } else {
                throw new Error(`Login failed: ${loginStatus.reason}. Please check credentials and ensure 2FA is disabled.`);
            }

        } catch (error: any) {
            console.error('[Bot] ❌ Error during Google login:', error.message);
            console.log('[Bot] Proceeding to join meeting anyway...');
        }
    }

    async joinMeeting(meetingUrl: string, botName: string): Promise<{ status: string, message: string }> {
        try {
            // Generate unique meeting ID for tracking
            this.meetingId = `meeting-${Date.now()}`;
            this.meetingStatus = 'joining';

            console.log(`[Bot] Launching browser for meeting: ${meetingUrl}`);

            // Launch Browser with specific args for media capture
            // Note: In Docker override we set PUPPETEER_EXECUTABLE_PATH
            this.browser = await launch({
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
                headless: false, // Must be false for stream capture in some environments
                defaultViewport: null, // Use window size
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage', // Critical for Docker
                    '--disable-gpu',
                    '--use-fake-ui-for-media-stream',
                    '--disable-notifications',
                    '--start-maximized'
                ],
                plugins: [StealthPlugin()]
            } as any);

            this.page = await this.browser.newPage();

            // 1. Login to Google Account (if credentials provided)
            await this.loginToGoogle();

            // 2. Navigate to Meeting
            console.log('[Bot] Navigating to URL...');
            await this.page.goto(meetingUrl, { waitUntil: 'networkidle2' });

            // 3. Handle Login / Guest Join
            // Google Meet often redirects to a login page or "Ready to join?" screen

            // Wait for input field for name (Guest mode) or Join button
            // Selectors can be dynamic, so we try a few common strategies

            console.log('[Bot] Waiting for pre-join screen...');
            await new Promise(r => setTimeout(r, 3000));

            // Try to find name input (Guest flow)
            // Note: Selectors for Google Meet change frequently. 
            // We look for inputs with specific attributes or visible text inputs
            const nameInputSelector = 'input[type="text"]';
            try {
                await this.page.waitForSelector(nameInputSelector, { timeout: 10000 });
                console.log('[Bot] Found name input. Typing name...');
                await this.page.type(nameInputSelector, botName);
                // remove Enter press to avoid premature submission
            } catch (e) {
                console.log('[Bot] Name input not found. Might be logged in or different flow.');
            }

            // 3. Click "Ask to join" or "Join now"
            // 3. Click "Ask to join" or "Join now"
            console.log('[Bot] Looking for Join button...');

            let clicked = false;
            // Retry loop            let clicked = false;
            for (let i = 0; i < 5; i++) {
                const joinResult = await this.page.evaluate(() => {
                    // Look for buttons or spans containing join text
                    const allButtons = Array.from(document.querySelectorAll('button, span[role="button"], div[role="button"]'));
                    const joinButton = allButtons.find(el => {
                        const text = el.textContent?.toLowerCase() || '';
                        return text.includes('join') ||
                            text.includes('ask to join') ||
                            text.includes('join now') ||
                            text.includes('join call');
                    });

                    if (joinButton) {
                        (joinButton as HTMLElement).click();
                        return { success: true, text: joinButton.textContent };
                    }

                    // Check for rejection
                    if (document.body.innerText.includes("You can't join this video call")) {
                        return { success: false, rejected: true, pageText: document.body.innerText.substring(0, 500) };
                    }

                    return { success: false, pageText: document.body.innerText.substring(0, 300) };
                });

                if ((joinResult as any).rejected) {
                    console.log('[Bot] Rejection detected. Page text:', (joinResult as any).pageText);

                    // Take screenshot before throwing error
                    const uploadDir = path.join(__dirname, '../uploads');
                    if (!fs.existsSync(uploadDir)) {
                        fs.mkdirSync(uploadDir, { recursive: true });
                    }
                    await this.page.screenshot({ path: path.join(uploadDir, 'rejection-debug.png') });
                    console.log('[Bot] Rejection screenshot saved to uploads/rejection-debug.png');

                    throw new Error("Meeting Rejected: This meeting does not allow anonymous guests.");
                }

                if (joinResult.success) {
                    console.log(`[Bot] Clicked button via evaluate: ${joinResult.text}`);
                    clicked = true;
                    break;
                }

                console.log(`[Bot] Button not found, attempt ${i + 1}/5. Page text:`, (joinResult as any).pageText);
                await new Promise(r => setTimeout(r, 2000));
            }

            if (!clicked) {
                // Ensure uploads directory exists for screenshot
                const uploadDir = path.join(__dirname, '../uploads');
                if (!fs.existsSync(uploadDir)) {
                    fs.mkdirSync(uploadDir, { recursive: true });
                }

                // Take screenshot for debugging
                const debugPath = path.join(uploadDir, 'debug-error.png');
                await this.page.screenshot({ path: debugPath });
                console.log(`[Bot] Saved debug screenshot to ${debugPath}`);

                // Dump page content
                const content = await this.page.content();
                console.log('[Bot] Page content length:', content.length);

                // Log visible text to see what happened
                const visibleText = await this.page.evaluate(() => document.body.innerText);
                console.log('[Bot] PAGE TEXT DUMP:', visibleText.substring(0, 500) + '...');

                throw new Error('Could not find Join button (Screenshot saved to uploads/debug-error.png)');
            }

            // 4. Start monitoring immediately - detect if meeting ends before bot is admitted
            this.monitorMeetingStatus();

            // 5. Wait for meeting to stabilize before starting transcription
            await new Promise(r => setTimeout(r, 10000)); // Wait 10 seconds for meeting to stabilize

            console.log('[Bot] Starting Gemini Live transcription...');
            this.startAudioCapture();

            this.meetingStatus = 'active';
            return { status: 'success', message: 'Bot joined meeting and started transcription.' };

        } catch (error: any) {
            console.error('[Bot] Error joining meeting:', error);
            await this.cleanup();
            throw new Error(`Failed to join: ${error.message}`);
        }
    }

    /**
     * Monitor meeting status and auto-end when meeting is over
     */
    private monitorMeetingStatus() {
        if (!this.page) return;

        console.log('[Bot] 🔍 Starting meeting status monitor...');

        const checkInterval = setInterval(async () => {
            try {
                if (!this.page || !this.browser) {
                    console.log('[Bot] Browser closed, stopping monitor');
                    clearInterval(checkInterval);
                    return;
                }

                // Check if meeting has ended or is empty
                const meetingStatus = await this.page.evaluate(() => {
                    const bodyText = document.body.innerText.toLowerCase();
                    const url = window.location.href;

                    // Check for common "meeting ended" indicators
                    const hasEndedText = bodyText.includes('you left the meeting') ||
                        bodyText.includes('meeting has ended') ||
                        bodyText.includes('call ended') ||
                        bodyText.includes('return to home screen') ||
                        bodyText.includes('returning to home screen') ||
                        bodyText.includes('rejoin');

                    // Check if redirected away from meeting
                    const leftMeeting = !url.includes('meet.google.com/') ||
                        url.includes('meet.google.com/?') ||
                        url === 'https://meet.google.com/';


                    // Check if we are truly INSIDE the meeting
                    // We look for the "Leave call" button which is only present in the actual meeting
                    const leaveButton = document.querySelector('button[aria-label="Leave call"]');
                    const inMeeting = leaveButton !== null;

                    // Check if bot is alone in meeting
                    // Google Meet shows participant count in various ways
                    const participantElements = document.querySelectorAll('[data-participant-id]');
                    const participantCount = participantElements.length;

                    // Critical: ONLY check if alone if we are positively IN the meeting
                    // This prevents false positives on pre-join screens
                    const aloneInMeeting = inMeeting && (
                        bodyText.includes("you're the only one here") ||
                        bodyText.includes('no one else is here') ||
                        participantCount === 1
                    );

                    // Check if meeting was ended by host
                    const hostEnded = bodyText.includes('meeting ended by host') ||
                        bodyText.includes('host has ended the meeting') ||
                        bodyText.includes('this call has ended');

                    const shouldEnd = hasEndedText || leftMeeting || aloneInMeeting || hostEnded;

                    let reason = 'Still in meeting';
                    if (hasEndedText) reason = 'Meeting ended text detected';
                    else if (leftMeeting) reason = 'Redirected away from meeting';
                    else if (aloneInMeeting) reason = 'Bot is alone in meeting';
                    else if (hostEnded) reason = 'Meeting ended by host';

                    return {
                        ended: shouldEnd,
                        reason,
                        participantCount
                    };
                })

                // Log monitoring status for debugging
                console.log(`[Bot] 🔍 Monitor check - Status: ${meetingStatus.ended ? 'ENDED' : 'ACTIVE'}, Reason: ${meetingStatus.reason}, Participants: ${meetingStatus.participantCount}`);

                if (meetingStatus.ended) {
                    console.log(`[Bot] 🔴 Meeting ended: ${meetingStatus.reason}`);
                    clearInterval(checkInterval);
                    await this.cleanup();
                }
            } catch (error: any) {
                console.error('[Bot] Error monitoring meeting:', error.message);
                clearInterval(checkInterval);
                await this.cleanup();
            }
        }, 2000); // Check every 2 seconds for faster detection
    }

    private async startAudioCapture() {
        if (!this.page) return;

        try {
            console.log('[Bot] Starting Gemini Live transcription...');

            // Initialize Gemini Live service
            this.geminiService = new GeminiLiveService();
            await this.geminiService.startSession(this.meetingId);

            this.isRecording = true;
            console.log('[Bot] ✅ Gemini Live transcription started');

            // TODO: Implement actual audio streaming from browser to Gemini
            // For now, we'll use a simplified approach where we periodically
            // capture audio chunks and send them to Gemini

        } catch (err: any) {
            console.error('[Bot] ❌ Gemini transcription error:', err.message);
            console.log('[Bot] Continuing without transcription. Meeting is still active.');
            // Don't throw - allow bot to stay in meeting even if transcription fails
        }
    }

    async leaveMeeting() {
        console.log('[Bot] Leaving meeting...');
        await this.cleanup();
        return { status: 'left' };
    }

    private async cleanup() {
        console.log('[Bot] Cleaning up meeting session...');

        // Stop Gemini transcription and generate summary
        if (this.geminiService) {
            try {
                const summary = await this.geminiService.generateSummary();
                console.log('[Bot] Meeting summary generated:', summary);
                await this.geminiService.endSession();
            } catch (error: any) {
                console.error('[Bot] Error generating summary:', error.message);
            }
            this.geminiService = null;
        }

        // Force close browser with error handling
        if (this.browser) {
            try {
                console.log('[Bot] Closing browser...');
                const pages = await this.browser.pages();
                console.log(`[Bot] Found ${pages.length} open pages`);

                // Close all pages first
                for (const page of pages) {
                    try {
                        await page.close();
                    } catch (err) {
                        console.log('[Bot] Error closing page:', err);
                    }
                }

                // Then close browser
                await this.browser.close();
                console.log('[Bot] Browser closed successfully');
            } catch (error: any) {
                console.error('[Bot] Error closing browser:', error.message);
                // Force kill browser process if close fails
                try {
                    const browserProcess = this.browser.process();
                    if (browserProcess) {
                        browserProcess.kill('SIGKILL');
                        console.log('[Bot] Browser process killed');
                    }
                } catch (killError: any) {
                    console.error('[Bot] Error killing browser process:', killError.message);
                }
            }
            this.browser = null;
            this.page = null;
        }

        this.isRecording = false;
        this.meetingStatus = 'ended';
        console.log('[Bot] ✅ Cleanup complete - meeting ended');
    }

    /**
     * Get current meeting status
     */
    getStatus(): { status: 'idle' | 'joining' | 'active' | 'ended'; meetingId: string; isRecording: boolean } {
        return {
            status: this.meetingStatus,
            meetingId: this.meetingId,
            isRecording: this.isRecording
        };
    }
}
