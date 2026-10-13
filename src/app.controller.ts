import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

@Controller()
export class AppController {
  @Get()
  getRoot(@Req() req: Request, @Res() res: Response) {
    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>AlgoFile Storage</title>
  <meta name="description" content="AlgoFile Integrated IPFS Storage Network & x402 Micro-payment Protocol">
  <meta property="og:title" content="AlgoFile Storage">
  <meta property="og:site_name" content="AlgoFile Storage">
  <meta property="og:description" content="AlgoFile Integrated IPFS Storage Network & x402 Micro-payment Protocol">
  <meta property="og:url" content="https://algofile.io">
  <meta property="og:image" content="https://algofile.io/logo_mini.png">
  <link rel="icon" href="https://algofile.io/logo_mini.png">
  <link rel="canonical" href="https://algofile.io">
</head>
<body>
  <h1>AlgoFile Storage API</h1>
  <p>AlgoFile Integrated IPFS Storage Network & x402 Micro-payment Protocol</p>
  <p><a href="https://algofile.io">https://algofile.io</a></p>
</body>
</html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    return res.json({
      status: 'ok',
      name: 'AlgoFile Storage',
      serviceName: 'AlgoFile Storage',
      description: 'AlgoFile Integrated IPFS Storage Network & x402 Micro-payment Protocol',
      website: 'https://algofile.io',
      apiUrl: 'https://api.algofile.io',
      iconUrl: 'https://algofile.io/logo_mini.png',
      timestamp: new Date().toISOString(),
    });
  }

  @Get('health')
  getHealthStatus() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
