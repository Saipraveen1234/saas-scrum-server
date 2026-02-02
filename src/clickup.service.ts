import { Request, Response } from "express";

const CLICKUP_API_URL = "https://api.clickup.com/api/v2";

export class ClickUpService {
    private apiKey: string;

    constructor() {
        this.apiKey = process.env.CLICKUP_API_KEY || "";
        if (!this.apiKey) {
            console.warn("WARNING: CLICKUP_API_KEY is not set.");
        }
    }

    async getTasks(listId: string): Promise<any[]> {
        if (!this.apiKey) return [];

        try {
            const response = await fetch(
                `${CLICKUP_API_URL}/list/${listId}/task?archived=false`,
                {
                    method: "GET",
                    headers: {
                        Authorization: this.apiKey,
                        "Content-Type": "application/json",
                    },
                }
            );

            if (!response.ok) {
                throw new Error(`ClickUp API Error: ${response.statusText}`);
            }

            const data = await response.json();
            return data.tasks || [];
        } catch (error) {
            console.error("Failed to fetch ClickUp tasks:", error);
            throw error;
        }
    }

    async updateTaskStatus(taskId: string, status: string): Promise<any> {
        if (!this.apiKey) return null;

        try {
            const response = await fetch(
                `${CLICKUP_API_URL}/task/${taskId}`,
                {
                    method: "PUT",
                    headers: {
                        Authorization: this.apiKey,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ status })
                }
            );

            if (!response.ok) {
                throw new Error(`ClickUp API Error: ${response.statusText}`);
            }

            return await response.json();
        } catch (error) {
            console.error(`Failed to update ClickUp task ${taskId}:`, error);
            throw error;
        }
    }

}
