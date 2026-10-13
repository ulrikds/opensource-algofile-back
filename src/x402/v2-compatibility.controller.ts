import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Response, Request } from 'express';
import { X402Service, ProjectMetadataResolver } from './x402.service';
import { ConfigService } from '@nestjs/config';
import { X402PaymentRequirements } from './x402.types';

@Controller()
export class V2CompatibilityController {
  constructor(
    private readonly x402Service: X402Service,
    private readonly configService: ConfigService,
  ) { }

  @Get('v3/challenge/upload')
  @Post('v3/challenge/upload')
  @Get('v3/filebase/upload')
  @Post('v3/filebase/upload')
  @Get('v3/algofile/upload')
  @Post('v3/algofile/upload')
  @Get('api/v3/challenge/upload')
  @Post('api/v3/challenge/upload')
  @Get('api/v3/filebase/upload')
  @Post('api/v3/filebase/upload')
  @Get('api/v3/algofile/upload')
  @Post('api/v3/algofile/upload')
  @Get('v2/challenge/upload')
  @Post('v2/challenge/upload')
  @Get('v2/filebase/upload')
  @Post('v2/filebase/upload')
  @Get('algofile/upload')
  @Get('filebase/upload')
  @Get('api/v2/challenge/upload')
  @Post('api/v2/challenge/upload')
  @Get('api/v2/filebase/upload')
  @Post('api/v2/filebase/upload')
  @Get('api/algofile/upload')
  @Get('api/filebase/upload')
  async handleV2UploadChallenge(@Req() req: any, @Res() res: any) {
    return this.sendUploadChallenge(req, res);
  }

  private sendUploadChallenge(req: Request, res: Response) {
    const reqUrl = (req.originalUrl || req.url || '/api/v3/algofile/upload').toString();
    const requirements = this.x402Service.createRequirements({
      url: reqUrl,
      amount: '1000',
    });

    const bazaarExtension = ProjectMetadataResolver.buildBazaarExtension({
      method: req.method.toUpperCase() as 'GET' | 'POST',
      input: {},
      output: { success: true, cid: 'bafkreic...' },
    });

    return this.x402Service.send402Response(
      res,
      requirements,
      bazaarExtension,
      'Payment Required for AlgoFile Decentralized Storage ($0.001 USDC)',
    );
  }

  @Get('agent-card.json')
  @Get('api/agent-card.json')
  @Get('.well-known/agent-card.json')
  @Get('api/.well-known/agent-card.json')
  @Get('.well-known/x402.json')
  @Get('api/.well-known/x402.json')
  getAgentCard() {
    return ProjectMetadataResolver.getAgentCard();
  }

  @Get('llms.txt')
  @Get('api/llms.txt')
  getLlmsTxt(@Res() res: Response) {
    const content = `# AlgoFile Storage

> AlgoFile Integrated IPFS Storage Network & x402 Micro-payment Protocol.

- Website: https://algofile.io
- API Endpoint: https://api.algofile.io
- Icon: https://algofile.io/logo_mini.png
- Storage Info: https://api.algofile.io/api/v3/x402/bazaar/storage-info
- Asset Info: https://api.algofile.io/api/v3/x402/bazaar/asset-storage-info
- Verify Purchase: https://api.algofile.io/api/v3/purchases/x402-verify
- Provision Bucket: https://api.algofile.io/api/v3/collections/provision-bundle-bucket-x402
- Tag: x402-global-challenge
`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(content);
  }
}
