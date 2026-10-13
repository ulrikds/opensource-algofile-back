import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import * as express from 'express';

// Suppress Mongoose deprecation warnings from third-party dependencies
process.on('warning', (warning) => {
  if (
    warning.name === 'DeprecationWarning' &&
    warning.message.includes('findOneAndUpdate')
  ) {
    return;
  }
  console.warn(warning.stack || warning.message);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);

  // Increase request body size limit for bulk operations
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // Enable open CORS for public AI Agent protocol (x402 / Bazaar / Filebase)
  app.enableCors({
    origin: true, // Allow external AI agents & DApps to communicate from any origin
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
      '*',
      'Content-Type',
      'Authorization',
      'x-api-key',
      'payment-required',
      'Payment-Required',
      'PAYMENT-REQUIRED',
      'payment-response',
      'Payment-Response',
      'PAYMENT-RESPONSE',
      'X-Payment-Required',
      'x-payment-required',
      'payment-signature',
      'Payment-Signature',
      'PAYMENT-SIGNATURE',
      'x-x402-payment-payload',
      'X-X402-Payment-Payload',
      'x-payment-payload',
      'X-Payment-Payload',
      'x-agent-id',
      'agent-id',
      'x-preferred-currency',
    ],
    exposedHeaders: [
      '*',
      'payment-required',
      'Payment-Required',
      'PAYMENT-REQUIRED',
      'payment-response',
      'Payment-Response',
      'PAYMENT-RESPONSE',
      'X-Payment-Required',
      'x-payment-required',
      'payment-signature',
      'Payment-Signature',
      'PAYMENT-SIGNATURE',
      'x-x402-payment-payload',
      'X-X402-Payment-Payload',
      'x-payment-payload',
      'X-Payment-Payload',
      'x-agent-id',
    ],
    credentials: true,
  });

  // Express middleware to rewrite non-api-prefixed protocol requests to /api/...
  app.use((req: any, res: any, next: any) => {
    const rawPath = req.url.split('?')[0];
    if (rawPath === '' || rawPath === '/') {
      const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
      req.url = `/api${query}`;
    } else if (
      !req.url.startsWith('/api/') &&
      (req.url.includes('/collections/') ||
        req.url.includes('/purchases/') ||
        req.url.includes('/x402/') ||
        req.url.includes('/algofile/') ||
        req.url.includes('/filebase/') ||
        req.url.includes('/v3/') ||
        req.url.includes('/.well-known/') ||
        req.url.includes('agent-card.json') ||
        req.url.includes('llms.txt') ||
        req.url.includes('/health'))
    ) {
      req.url = `/api${req.url.startsWith('/') ? '' : '/'}${req.url}`;
    }
    next();
  });

  // Set global API prefix
  app.setGlobalPrefix('api');

  const port = configService.get<number>('PORT') || 3001;

  await app.listen(port);
  console.log(`Backend server successfully started on port: ${port}`);
}
bootstrap();
