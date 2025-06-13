import crypto from 'crypto';
import { storage } from './storage';
import type { Webhook, ActivityLog } from '@shared/schema';

export interface WebhookPayload {
  event: string;
  timestamp: string;
  application_id: number;
  user_data?: {
    id: number;
    username: string;
    email?: string;
    hwid?: string;
    ip_address?: string;
    user_agent?: string;
    location?: string;
  };
  metadata?: any;
  success: boolean;
  error_message?: string;
}

export class WebhookService {
  private static instance: WebhookService;
  
  static getInstance(): WebhookService {
    if (!WebhookService.instance) {
      WebhookService.instance = new WebhookService();
    }
    return WebhookService.instance;
  }

  private generateSignature(payload: string, secret: string): string {
    return crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
  }

  private formatDiscordWebhook(payload: WebhookPayload): any {
    const color = payload.success ? 0x00ff00 : 0xff0000; // Green for success, red for failure
    const eventEmoji: Record<string, string> = {
      'user_login': '🔐',
      'login_failed': '❌',
      'user_register': '👤',
      'account_expired': '⏰',
      'hwid_mismatch': '🔒',
      'version_mismatch': '🔄',
      'account_disabled': '🚫',
      'login_blocked_ip': '🚫',
      'login_blocked_username': '🚫',
      'login_blocked_hwid': '🚫'
    };

    interface DiscordEmbedField {
      name: string;
      value: string;
      inline: boolean;
    }

    const fields: DiscordEmbedField[] = [];

    const embed = {
      title: `${eventEmoji[payload.event as keyof typeof eventEmoji] || '📊'} ${payload.event.replace('_', ' ').toUpperCase()}`,
      color: color,
      timestamp: payload.timestamp,
      fields: fields,
      footer: {
        text: `Application ID: ${payload.application_id}`
      }
    };

    if (payload.user_data) {
      fields.push({
        name: 'User Information',
        value: `**Username:** ${payload.user_data.username}\n${payload.user_data.email ? `**Email:** ${payload.user_data.email}\n` : ''}${payload.user_data.ip_address ? `**IP:** ${payload.user_data.ip_address}\n` : ''}${payload.user_data.hwid ? `**HWID:** ${payload.user_data.hwid}\n` : ''}`,
        inline: true
      });
    }

    if (payload.error_message) {
      fields.push({
        name: 'Error Details',
        value: payload.error_message,
        inline: false
      });
    }

    if (payload.metadata) {
      fields.push({
        name: 'Additional Information',
        value: Object.entries(payload.metadata).map(([key, value]) => `**${key}:** ${value}`).join('\n'),
        inline: false
      });
    }

    return {
      embeds: [embed]
    };
  }

  async sendWebhook(webhook: Webhook, payload: WebhookPayload, retryCount: number = 0): Promise<boolean> {
    const maxRetries = 3;
    const retryDelay = Math.pow(2, retryCount) * 1000; // Exponential backoff
    
    try {
      // Check if this is a Discord webhook URL
      const isDiscordWebhook = webhook.url.includes('discord.com/api/webhooks');
      
      let webhookPayload;
      if (isDiscordWebhook) {
        webhookPayload = this.formatDiscordWebhook(payload);
      } else {
        webhookPayload = payload;
      }

      const payloadString = JSON.stringify(webhookPayload);
      const signature = webhook.secret 
        ? this.generateSignature(payloadString, webhook.secret)
        : undefined;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'PhantomAuth-Webhook/1.0',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      };

      // Only add custom headers for non-Discord webhooks
      if (!isDiscordWebhook) {
        headers['X-Webhook-Timestamp'] = payload.timestamp;
        headers['X-Webhook-Event'] = payload.event;
        headers['X-Webhook-Retry-Count'] = retryCount.toString();
        
        if (signature) {
          headers['X-Webhook-Signature'] = `sha256=${signature}`;
        }
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000); // Increased timeout for global server compatibility
      
      console.log(`Sending webhook to: ${webhook.url} (attempt ${retryCount + 1}/${maxRetries + 1})`);
      
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: payloadString,
        signal: controller.signal,
        // Global server compatibility settings
        keepalive: true,
        redirect: 'follow'
      });
      
      clearTimeout(timeoutId);

      console.log('Webhook response status:', response.status);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('Webhook error response:', errorText);
        
        // Retry on server errors (5xx) and rate limits (429)
        if ((response.status >= 500 || response.status === 429) && retryCount < maxRetries) {
          console.log(`Retrying webhook in ${retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          return this.sendWebhook(webhook, payload, retryCount + 1);
        }
      }

      return response.ok;
    } catch (error) {
      console.error('Webhook delivery failed:', error);
      
      // Retry on network errors
      if (retryCount < maxRetries && (
        error instanceof Error && (
          error.name === 'AbortError' ||
          error.name === 'TypeError' ||
          error.message.includes('fetch') ||
          error.message.includes('network')
        )
      )) {
        console.log(`Retrying webhook in ${retryDelay}ms due to network error...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        return this.sendWebhook(webhook, payload, retryCount + 1);
      }
      
      return false;
    }
  }

  async deliverWebhooks(userId: string, event: string, payload: WebhookPayload): Promise<void> {
    try {
      const webhooks = await storage.getUserWebhooks(userId);
      console.log(`Attempting to deliver webhook for event: ${event}`);
      console.log(`Found ${webhooks.length} webhooks for user ${userId}`);
      
      const activeWebhooks = webhooks.filter(w => 
        w.isActive && w.events.includes(event)
      );
      
      console.log(`Active webhooks for event ${event}:`, activeWebhooks.length);
      activeWebhooks.forEach(w => {
        console.log(`Webhook ${w.id} events:`, w.events);
      });

      // Send webhooks in parallel
      const deliveryPromises = activeWebhooks.map(webhook => 
        this.sendWebhook(webhook, payload)
      );

      await Promise.allSettled(deliveryPromises);
    } catch (error) {
      console.error('Failed to deliver webhooks:', error);
    }
  }

  async logActivity(activityData: {
    applicationId: number;
    appUserId?: number;
    event: string;
    ipAddress?: string;
    hwid?: string;
    userAgent?: string;
    metadata?: any;
    success?: boolean;
    errorMessage?: string;
  }): Promise<void> {
    try {
      // Only include appUserId if it's a valid number and the user exists
      const logData = {
        ...activityData,
        success: activityData.success ?? true,
      };
      
      // Remove appUserId if it doesn't exist or is invalid
      if (activityData.appUserId && activityData.appUserId > 0) {
        try {
          const userExists = await storage.getAppUser(activityData.appUserId);
          if (!userExists) {
            delete logData.appUserId;
          }
        } catch {
          delete logData.appUserId;
        }
      } else {
        delete logData.appUserId;
      }
      
      await storage.createActivityLog(logData);
    } catch (error) {
      console.error('Failed to log activity:', error);
      // Don't throw the error - continue with webhook delivery even if logging fails
    }
  }

  async logAndNotify(
    userId: string,
    applicationId: number,
    event: string,
    userData?: any,
    options: {
      success?: boolean;
      errorMessage?: string;
      metadata?: any;
      ipAddress?: string;
      hwid?: string;
      userAgent?: string;
    } = {}
  ): Promise<void> {
    // Log the activity
    await this.logActivity({
      applicationId,
      appUserId: userData?.id,
      event,
      ipAddress: options.ipAddress,
      hwid: options.hwid,
      userAgent: options.userAgent,
      metadata: options.metadata,
      success: options.success ?? true,
      errorMessage: options.errorMessage,
    });

    // Prepare webhook payload
    const webhookPayload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      application_id: applicationId,
      success: options.success ?? true,
      error_message: options.errorMessage,
      metadata: options.metadata,
    };

    if (userData) {
      webhookPayload.user_data = {
        id: userData.id,
        username: userData.username,
        email: userData.email,
        hwid: userData.hwid || options.hwid,
        ip_address: options.ipAddress,
        user_agent: options.userAgent,
      };
    }

    // Deliver webhooks
    await this.deliverWebhooks(userId, event, webhookPayload);
  }
}

export const webhookService = WebhookService.getInstance();