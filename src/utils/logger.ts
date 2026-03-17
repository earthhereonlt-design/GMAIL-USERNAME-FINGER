import fs from 'fs';
import path from 'path';

const LOG_FILE = path.join(process.cwd(), 'app.log');

export enum LogLevel {
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  DEBUG = 'DEBUG'
}

class Logger {
  constructor() {
  }

  private formatMessage(level: LogLevel, message: string, context?: any): string {
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` | Context: ${JSON.stringify(context)}` : '';
    return `[${timestamp}] [${level}] ${message}${contextStr}\n`;
  }

  private log(level: LogLevel, message: string, context?: any) {
    const formattedMessage = this.formatMessage(level, message, context);
    
    // Log to console with colors (simple version)
    const color = level === LogLevel.ERROR ? '\x1b[31m' : level === LogLevel.WARN ? '\x1b[33m' : '\x1b[32m';
    console.log(`${color}${formattedMessage}\x1b[0m`.trim());

    // Log to file immediately
    try {
      fs.appendFileSync(LOG_FILE, formattedMessage);
    } catch (e) {
      console.error('Failed to write to log file', e);
    }
  }

  info(message: string, context?: any) {
    this.log(LogLevel.INFO, message, context);
  }

  warn(message: string, context?: any) {
    this.log(LogLevel.WARN, message, context);
  }

  error(message: string, context?: any) {
    this.log(LogLevel.ERROR, message, context);
  }

  debug(message: string, context?: any) {
    this.log(LogLevel.DEBUG, message, context);
  }

  getLogFilePath(): string {
    return LOG_FILE;
  }
}

export const logger = new Logger();
