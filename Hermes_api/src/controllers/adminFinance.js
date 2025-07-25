// File: src/controllers/adminPayments.js
// Admin-controlled manual payment confirmation system
const { prisma, logger, bridgeContract, relayer, provider } = require('../config');
const { ethers } = require('ethers');

class AdminPaymentController {

  
/**
 * @desc    Get treasury overview and fee collections
 * @route   GET /api/admin/finance/treasury
 * @access  Private/Admin
 */
async getTreasuryOverview(req, res) {
  try {
    // 1. Get total fees collected
    const feeSummary = await prisma.feeCollection.groupBy({
      by: ['feeType'],
      _sum: {
        amount: true,
      },
      _count: {
        id: true,
      },
    });

    // 2. Get recent fee collections
    const recentFees = await prisma.feeCollection.findMany({
      take: 10,
      orderBy: {
        timestamp: 'desc',
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            walletAddress: true,
          },
        },
      },
    });

    // 3. Get bridge stats (from contract or cache)
    // TODO: Add bridge.getBridgeStatus() call here

    res.json({
      success: true,
      data: {
        feeSummary,
        recentFees,
        // bridgeStats: ...
      },
    });
  } catch (error) {
    logger.error('Failed to get treasury overview:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load treasury data',
    });
  }
}

/**
 * @desc    Get user's on-chain UGDX balance
 * @route   GET /api/admin/payments/balance/:userId
 * @access  Private/Admin
 */
async getUserBalance(req, res) {
  try {
    const { userId } = req.params;
    
    // Get user from database
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        walletAddress: true,
        ugdxCredit: true,
        role: true
      }
    });
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    if (!user.walletAddress) {
      return res.json({
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            role: user.role
          },
          walletAddress: null,
          onChainBalance: '0',
          offChainBalance: user.ugdxCredit?.toString() || '0',
          message: 'User has no wallet address'
        }
      });
    }
    
    // Query on-chain UGDX balance using ethers v6
    const { ugdxContract } = require('../config');
    const balance = await ugdxContract.balanceOf(user.walletAddress);
    const balanceFormatted = ethers.formatEther(balance);
    
    logger.info(`[${new Date().toISOString().slice(11, 23)}] 🔍 ADMIN QUERY: ${user.email} balance check - On-chain: ${balanceFormatted} UGDX, Off-chain: ${user.ugdxCredit || 0}`);
    
    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: user.role
        },
        walletAddress: user.walletAddress,
        onChainBalance: balanceFormatted,
        offChainBalance: user.ugdxCredit?.toString() || '0',
        balanceRaw: balance.toString(),
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    logger.error('Failed to get user balance:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to query user balance',
      error: error.message
    });
  }
}

  /**
   * GET /admin/payments/pending - List all pending mobile money jobs
   */
  async getPendingPayments(req, res) {
    try {
      const pendingJobs = await prisma.mobileMoneyJob.findMany({
        where: { 
          status: 'PENDING',
          type: 'COLLECT'  // Only show deposit requests
        },
        include: {
          user: {
            select: { id: true, email: true, phone: true, walletAddress: true }
          },
          transaction: true
        },
        orderBy: { createdAt: 'desc' }
      });

      const formattedJobs = pendingJobs.map(job => ({
        jobId: job.id,
        transactionId: job.transaction?.id,
        userEmail: job.user.email,
        userPhone: job.user.phone,
        walletAddress: job.user.walletAddress,
        amount: parseFloat(job.amount),
        provider: job.provider,
        createdAt: job.createdAt,
        status: job.status
      }));

      res.json({
        success: true,
        pendingPayments: formattedJobs,
        count: formattedJobs.length
      });
    } catch (error) {
      logger.error('Error fetching pending payments:', error);
      res.status(500).json({ error: 'Failed to fetch pending payments' });
    }
  }

  /**
   * POST /admin/payments/confirm - Manually confirm a mobile money payment
   */
  async confirmPayment(req, res) {
    try {
      const { jobId, providerTransactionId, notes } = req.body;
      
      if (!jobId) {
        return res.status(400).json({ error: 'Job ID is required' });
      }

      // Find the mobile money job and associated transaction
      const mmJob = await prisma.mobileMoneyJob.findUnique({
        where: { id: parseInt(jobId) },
        include: {
          user: true,
          transaction: true
        }
      });

      if (!mmJob) {
        return res.status(404).json({ error: 'Mobile money job not found' });
      }

      if (mmJob.status !== 'PENDING') {
        return res.status(400).json({ error: `Payment already ${mmJob.status.toLowerCase()}` });
      }

      if (mmJob.type !== 'COLLECT') {
        return res.status(400).json({ error: 'Can only confirm collection (deposit) payments' });
      }

      const user = mmJob.user;
      const transaction = mmJob.transaction;

      if (!user.walletAddress) {
        return res.status(400).json({ error: 'User has no wallet address to receive UGDX' });
      }

      logger.info(`Admin confirming payment: Job #${jobId}, Amount: ${mmJob.amount} UGX for user ${user.email}`);
      logger.info(`☯️ User details - ID: ${user.id}, Email: ${user.email}, Wallet: ${user.walletAddress}`);

      // Calculate UGDX amount (1:1 with UGX, minus fees already calculated)
      const ugdxAmount = parseFloat(transaction.ugdxAmount);
      const ugdxAmountWei = ethers.parseUnits(ugdxAmount.toString(), 18);

      // Perform the on-chain UGDX mint via Bridge contract (which owns UGDX)
      try {
        logger.info(`☯️ Minting ${ugdxAmount} UGDX to wallet: ${user.walletAddress} for user: ${user.email}`);
        
        // Use Bridge contract's new adminMintUGDX function
        // Relayer is the Bridge owner, so it can call onlyOwner functions
        const { bridgeContract } = require('../config');
        
        const tx = await bridgeContract.connect(relayer).adminMintUGDX(
          user.walletAddress,
          ugdxAmountWei
        );
        
        const receipt = await tx.wait();
        logger.info(`UGDX minted successfully! TxHash: ${receipt.hash}`);

        // Update database records in a transaction
        await prisma.$transaction(async (db) => {
          // Update mobile money job status
          await db.mobileMoneyJob.update({
            where: { id: mmJob.id },
            data: {
              status: 'SUCCESS',
              trans_id: providerTransactionId || `MANUAL_${Date.now()}`
            }
          });

          // Update transaction status
          await db.transaction.update({
            where: { id: transaction.id },
            data: {
              status: 'COMPLETED',
              txHash: receipt.hash
            }
          });

          // Log admin action
          logger.info(`Admin ${req.user?.email || 'SYSTEM'} confirmed payment Job #${jobId}. Notes: ${notes || 'None'}`);
        });

        res.json({
          success: true,
          message: `Payment confirmed and ${ugdxAmount} UGDX minted to ${user.walletAddress}`,
          txHash: receipt.hash,
          ugdxMinted: ugdxAmount
        });

      } catch (mintError) {
        logger.error('Failed to mint UGDX:', mintError);
        
        // Update job status to failed
        await prisma.mobileMoneyJob.update({
          where: { id: mmJob.id },
          data: { status: 'FAIL' }
        });

        await prisma.transaction.update({
          where: { id: transaction.id },
          data: { status: 'FAILED' }
        });

        res.status(500).json({ 
          error: 'Failed to mint UGDX on blockchain',
          details: mintError.message 
        });
      }

    } catch (error) {
      logger.error('Error confirming payment:', error);
      res.status(500).json({ error: 'Failed to confirm payment' });
    }
  }

  /**
   * POST /admin/payments/reject - Manually reject a mobile money payment
   */
  async rejectPayment(req, res) {
    try {
      const { jobId, reason } = req.body;
      
      if (!jobId) {
        return res.status(400).json({ error: 'Job ID is required' });
      }

      const mmJob = await prisma.mobileMoneyJob.findUnique({
        where: { id: parseInt(jobId) },
        include: { transaction: true, user: true }
      });

      if (!mmJob) {
        return res.status(404).json({ error: 'Mobile money job not found' });
      }

      if (mmJob.status !== 'PENDING') {
        return res.status(400).json({ error: `Payment already ${mmJob.status.toLowerCase()}` });
      }

      // Update both records to failed status
      await prisma.$transaction(async (db) => {
        await db.mobileMoneyJob.update({
          where: { id: mmJob.id },
          data: { status: 'FAIL' }
        });

        await db.transaction.update({
          where: { id: mmJob.transaction.id },
          data: { status: 'FAILED' }
        });
      });

      logger.info(`Admin rejected payment Job #${jobId}. Reason: ${reason || 'No reason provided'}`);

      res.json({
        success: true,
        message: `Payment Job #${jobId} rejected`,
        reason: reason || 'No reason provided'
      });

    } catch (error) {
      logger.error('Error rejecting payment:', error);
      res.status(500).json({ error: 'Failed to reject payment' });
    }
  }

  /**
   * GET /admin/payments/history - Get payment history with filters
   */
  async getPaymentHistory(req, res) {
    try {
      const { status, limit = 50, offset = 0 } = req.query;
      
      const where = {};
      if (status) {
        where.status = status.toUpperCase();
      }

      const jobs = await prisma.mobileMoneyJob.findMany({
        where,
        include: {
          user: {
            select: { id: true, email: true, phone: true }
          },
          transaction: true
        },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset)
      });

      const total = await prisma.mobileMoneyJob.count({ where });

      res.json({
        success: true,
        payments: jobs,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: total > parseInt(offset) + parseInt(limit)
        }
      });

    } catch (error) {
      logger.error('Error fetching payment history:', error);
      res.status(500).json({ error: 'Failed to fetch payment history' });
    }
  }
}

module.exports = new AdminPaymentController();
