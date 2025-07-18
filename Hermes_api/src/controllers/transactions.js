    // src/controllers/transactionController.js
const { prisma, logger, ugdxContract, bridgeContract, forwarderContract, relayer, provider, PROVIDER_FEE_BPS } = require('../config');
const ethers = require('ethers');
const mmService = require('../services/mmService');

// Helper: calculate provider fee and net UGX after fee
function applyProviderFee(amountUgx) {
  const fee = (amountUgx * PROVIDER_FEE_BPS) / 10000;
  const net = amountUgx - fee;
  return { fee, net };
}

// Helper: deduct gas credit based on actual gas used by a transaction
async function deductGasCredit(user, tx, receipt, note) {
  const gasUsed = receipt.gasUsed;
  // Use gas price from tx or receipt (handle legacy vs EIP-1559), fallback to provider gas price
  const gasPrice = tx.gasPrice || (receipt.effectiveGasPrice ? receipt.effectiveGasPrice : await provider.getGasPrice());
  const costMatic = gasUsed.mul(gasPrice);
  // Convert gas cost (in MATIC) to ETH string, then to UGX (approximate rate: 1 MATIC ~ 3700 UGX)
  const costMaticInEth = ethers.utils.formatEther(costMatic);
  const costUGX = parseFloat(costMaticInEth) * 3700;
  const newCredit = Math.max(parseFloat(user.gasCredit) - costUGX, 0);
  // Update user's remaining gas credit and log the usage
  await prisma.user.update({ where: { id: user.id }, data: { gasCredit: newCredit } });
  await prisma.gasDrip.create({ data: { userId: user.id, amount: costUGX, type: "USE", note } });
}

class TransactionController {


// POST /transactions/mint - user deposits UGX to mint UGDX
  async mintUGDX(req, res, next) {
    try {
      const userId = req.user.userId;
      const { amountUGX } = req.body;
      if (!amountUGX || amountUGX <= 0) {
        return res.status(400).json({ error: "Deposit amount must be greater than 0." });
      }
      // Ensure user exists and has a wallet address to receive UGDX
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return res.status(404).json({ error: "User not found" });
      if (!user.walletAddress) {
        return res.status(400).json({ error: "No wallet address linked. Please add a crypto wallet address to receive UGDX." });
      }
      const phone = user.phone;  // use user's own phone for deposit
      // Calculate net UGDX after provider fee
      const { fee, net } = applyProviderFee(amountUGX);
      const ugdxToMint = net;  // assuming 1 UGX = 1 UGDX
      // Create a MobileMoneyJob entry for collection (deposit)
      const mmJob = await prisma.mobileMoneyJob.create({
        data: {
          userId: userId,
          phone: phone,
          amountUGX: amountUGX,
          type: "COLLECT",
          provider: providerName,
          status: "PENDING"
        }
      });
      // Create a Transaction entry for this mint operation
      const txn = await prisma.transaction.create({
        data: {
          userId: userId,
          type: "MINT",
          amountUGX: amountUGX,
          ugdxAmount: ugdxToMint,
          status: "PENDING",
          mmJobId: mmJob.id
        }
      });
      // Initiate the mobile money collection via provider API
      const result = await mmService.requestToPay({
        amount: amountUGX,
        phone: phone,
        trans_id: mmJob.id    // use our MobileMoneyJob ID as reference for callback
      });
      if (result.status === 'PENDING') {
        // Mobile money request initiated; actual confirmation will come via webhook callback
        logger.info(`Initiated UGX collection of ${amountUGX} via MM for user ${user.email} (Job #${mmJob.id}).`);
      }
      // Respond to client with net UGDX to be minted and transaction info
      return res.status(200).json({
        message: "Deposit initiated. You will receive UGDX shortly after the payment is confirmed.",
        netUGDX: ugdxToMint,
        feeUGX: fee,
        transactionId: txn.id
      });
    } catch (err) {
      next(err);
    }
  };

// POST /transactions/redeem - user withdraws UGX by burning UGDX
  async redeemUGDX(req, res, next) {
    try {
      const userId = req.user.userId;
      const { amountUGDX, phone } = req.body;
      if (!amountUGDX || amountUGDX <= 0) {
        return res.status(400).json({ error: "Withdrawal amount must be greater than 0." });
      }
      // Determine target phone: use provided phone or default to user's phone
      const targetPhone = phone || (await prisma.user.findUnique({ where: { id: userId } }))?.phone;
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return res.status(404).json({ error: "User not found" });
      // If user has a wallet, check on-chain UGDX balance to ensure enough tokens to burn
      if (user.walletAddress) {
        const balanceBigInt = await ugdxContract.balanceOf(user.walletAddress);
        const balanceUGDX = ethers.utils.formatUnits(balanceBigInt, 18);
        if (parseFloat(balanceUGDX) < amountUGDX) {
          return res.status(400).json({ error: "Insufficient UGDX balance to redeem that amount." });
        }
      }
      // Calculate provider fee and net UGX that will be disbursed
      const { fee, net } = applyProviderFee(amountUGDX);
      const ugxToDisburse = net;  // UGX amount to send out (1 UGDX = 1 UGX)
      // Create a MobileMoneyJob for disbursement (withdrawal)
      const mmJob = await prisma.mobileMoneyJob.create({
        data: {
          userId: userId,
          phone: targetPhone,
          amountUGX: ugxToDisburse,
          type: "DISBURSE",
          provider: providerName,
          status: "PENDING"
        }
      });
      // Create a Transaction entry for this redeem operation
      const txn = await prisma.transaction.create({
        data: {
          userId: userId,
          type: "REDEEM",
          amountUGX: ugxToDisburse,
          ugdxAmount: amountUGDX,
          toPhone: targetPhone,
          status: "PENDING",
          mmJobId: mmJob.id
        }
      });
      // If user is not advanced, perform on-chain token burn via meta-transaction
      if (req.user.role !== 'advanced') {
        const { signature } = req.body;
        if (!signature) {
          return res.status(400).json({ error: "Meta-transaction signature required for gasless withdrawal." });
        }
        // Construct call data for Bridge.burnForWithdrawal(amountUGDX)
        const iface = new ethers.utils.Interface([
          "function burnForWithdrawal(uint256 amount) public"
        ]);
        const data = iface.encodeFunctionData("burnForWithdrawal", [
          ethers.utils.parseUnits(amountUGDX.toString(), 18)
        ]);
        // Get current nonce for user in Forwarder and execute meta-tx via relayer
        const nonce = await forwarderContract.getNonce(user.walletAddress);
        try {
          const tx = await forwarderContract.execute(bridgeContract.address, data, user.walletAddress, nonce, signature);
          const receipt = await tx.wait();
          logger.info(`UGDX burn meta-tx sent by relayer, txHash: ${receipt.transactionHash}`);
          // Link on-chain tx hash to our Transaction record
          await prisma.transaction.update({
            where: { id: txn.id },
            data: { txHash: receipt.transactionHash }
          });
          // Deduct gas credit for this meta-transaction
          await deductGasCredit(user, tx, receipt, `Redeem tx ${receipt.transactionHash}`);
        } catch (err) {
          logger.error("Meta-transaction execution failed:", err);
          return res.status(500).json({ error: "Failed to execute token burn transaction." });
        }
      } else {
        // Advanced user: expected to perform the burn on-chain themselves (no gas credit deduction)
        logger.info(`Advanced user ${user.email} initiated a withdrawal; awaiting on-chain burn confirmation.`);
      }
      // Initiate the mobile money payout via provider API
      await mmService.requestWithdrawal({
        amount: ugxToDisburse,
        phone: targetPhone,
        trans_id: mmJob.id   // reference our MobileMoneyJob ID for callback tracking
      });
      // Respond to client with the expected UGX disbursement and transaction reference
      return res.status(200).json({
        message: "Withdrawal initiated. UGX will be sent to the target mobile money account shortly.",
        netUGX: ugxToDisburse,
        feeUGX: fee,
        transactionId: txn.id
      });
    } catch (err) {
      next(err);
    }
  };

// POST /transactions/send - user sends UGDX to address or phone
 async sendUGDX (req, res, next) {
  try {
    const userId = req.user.userId;
    const { amountUGDX, phone, toAddress, signature } = req.body;
    // ... (validation and user lookup)
    if (phone) {
      // User is sending UGX to a phone (mobile money transfer)
      const targetPhone = phone;
      // Ensure user has enough UGDX on-chain (if wallet linked)
      if (user.walletAddress) {
        const balance = await ugdxContract.balanceOf(user.walletAddress);
        if (parseFloat(ethers.utils.formatUnits(balance, 18)) < amountUGDX) {
          return res.status(400).json({ error: "Insufficient UGDX balance." });
        }
      }
      const { fee, net } = applyProviderFee(amountUGDX);
      const ugxToSend = net;
      // Create MobileMoneyJob and Transaction records (type "SEND")
      const mmJob = await prisma.mobileMoneyJob.create({data: {
        userId,
        phone: targetPhone,
        amountUGX: ugxToSend,
        type: "DISBURSE",
        provider: providerName,
        status: "PENDING"
      }});
      const txn = await prisma.transaction.create({ data: {
        userId,
        type: "SEND",
        amountUGX: ugxToSend,
        ugdxAmount: amountUGDX,
        toPhone: targetPhone,
        status: "PENDING",
        mmJobId: mmJob.id
      }});
      if (req.user.role !== 'ADVANCED') {
        // Normal user: burn UGDX via meta-tx then trigger payout
        if (!signature) {
          return res.status(400).json({ error: "Meta-transaction signature required for send-to-phone." });
        }
        const iface = new ethers.utils.Interface([ "function burnForWithdrawal(uint256 amount) public" ]);
        const data = iface.encodeFunctionData("burnForWithdrawal", [ ethers.utils.parseUnits(amountUGDX.toString(), 18) ]);
        try {
          const nonce = await forwarderContract.getNonce(user.walletAddress);
          const tx = await forwarderContract.execute(bridgeContract.address, data, user.walletAddress, nonce, signature);
          const receipt = await tx.wait();
          logger.info(`UGDX burn (send to phone) via meta-tx, txHash: ${receipt.transactionHash}`);
          await prisma.transaction.update({
            where: { id: txn.id },
            data: { txHash: receipt.transactionHash }
          });
          // Deduct gas credit as above...
        } catch (err) {
          logger.error("Meta-transaction burn for send failed:", err);
          return res.status(500).json({ error: "Failed to burn tokens for send." });
        }
        // Initiate mobile money disbursement for normal user
        await mmService.requestWithdrawal({
          amount: ugxToSend,
          phone: targetPhone,
          trans_id: mmJob.id.toString()
        });
        logger.info(`Mobile money send requested (Job #${mmJob.id}) for user ${user.email}`);
      } else {
        // Advanced user: user will burn tokens on-chain themselves
        logger.info(`Advanced user ${user.email} will burn ${amountUGDX} UGDX on-chain for send-to-phone. Awaiting burn event.`);
        // No mobile money request now; wait for event to trigger payout
      }
      return res.status(200).json({
        message: "Transfer initiated. UGX will be sent once token burn is confirmed on-chain.",
        netUGX: ugxToSend,
        feeUGX: fee,
        transactionId: txn.id
      });
    } else if (toAddress) {
      // User is sending UGDX to a crypto address (on-chain transfer)
      const targetAddress = toAddress;
      // Ensure user has enough UGDX on-chain
      if (user.walletAddress) {
        const balance = await ugdxContract.balanceOf(user.walletAddress);
        if (parseFloat(ethers.utils.formatUnits(balance, 18)) < amountUGDX) {
          return res.status(400).json({ error: "Insufficient UGDX balance." });
        }
      }
      // Create Transaction record for this send operation
      const txn = await prisma.transaction.create({
        data: {
          userId,
          type: "SEND",
          amountUGX: 0,  // no UGX involved in crypto send
          ugdxAmount: amountUGDX,
          toAddress: targetAddress,
          status: "PENDING"
        }
      });
      if (req.user.role !== 'ADVANCED') {
        // Normal user: burn UGDX via meta-tx
        if (!signature) {
          return res.status(400).json({ error: "Meta-transaction signature required for send-to-address." });
        }
        const iface = new ethers.utils.Interface([ "function burnForWithdrawal(uint256 amount) public" ]);
        const data = iface.encodeFunctionData("burnForWithdrawal", [ ethers.utils.parseUnits(amountUGDX.toString(), 18) ]);
        try {
          const nonce = await forwarderContract.getNonce(user.walletAddress);
          const tx = await forwarderContract.execute(bridgeContract.address, data, user.walletAddress, nonce, signature);
          const receipt = await tx.wait();
          logger.info(`UGDX burn (send to address) via meta-tx, txHash: ${receipt.transactionHash}`);
          await prisma.transaction.update({
            where: { id: txn.id },
            data: { txHash: receipt.transactionHash }
          });
          // Deduct gas credit as above...
        } catch (err) {
          logger.error("Meta-transaction burn for send failed:", err);
          return res.status(500).json({ error: "Failed to burn tokens for send." });
        }
      } else {
        // Advanced user will perform the burn on-chain themselves
        logger.info(`Advanced user ${user.email} will burn ${amountUGDX} UGDX on-chain for send-to-address. Awaiting burn event.`);
      }
      // Respond with transaction info
      return res.status(200).json({
        message: "Transfer initiated. UGDX will be sent once token burn is confirmed on-chain.",
        transactionId: txn.id
      });
    } else {
      return res.status(400).json({ error: "Invalid request. Specify a toAddress or phone." });
    }
  } catch (err) {
    next(err);
  }
};

// GET /transactions/history - list of user's past transactions
 async getHistory (req, res, next) {
  try {
    const userId = req.user.userId;
    // Fetch transactions for user, most recent first
    const history = await prisma.transaction.findMany({
      where: { userId: userId },
      orderBy: { createdAt: 'desc' },
      include: {
        mmJob: true  // include related mobile money job if any (to get phone, provider, etc.)
      }
    });
    return res.json({ history });
  } catch (err) {
    next(err);
  }
};

// GET /rates/current - returns current exchange rates for UGDX
 async getCurrentRates (req, res, next) {
  try {
    // Fetch on-chain rate if available from Oracle or Bridge
    let ugxPerUSD = 3700;
    try {
      const rate = await bridgeContract.ugxPerUSD();
      ugxPerUSD = parseInt(rate.toString()) / 1e18;  // assuming ugxPerUSD stored with 18 decimals
    } catch (err) {
      // If call fails, use default 3700 UGX = 1 USD (example)
    }
    // UGDX is pegged 1:1 to UGX, so 1 UGDX = 1 UGX
    const ugdxPerUGX = 1;
    const usdPerUGX = 1 / ugxPerUSD;
    return res.json({
      ugxPerUSD: ugxPerUSD,
      usdPerUGX: usdPerUGX,
      ugdxPerUGX: ugdxPerUGX
    });
  } catch (err) {
    next(err);
  }
};

}

module.exports = new TransactionController();