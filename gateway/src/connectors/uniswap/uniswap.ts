import {
  InitializationError,
  UniswapishPriceError,
  SERVICE_UNITIALIZED_ERROR_CODE,
  SERVICE_UNITIALIZED_ERROR_MESSAGE,
} from '../../services/error-handler';
import { UniswapConfig } from './uniswap.config';
import routerAbi from './uniswap_v2_router_abi.json';
import factoryAbi from './uniswap_v2_factory_abi.json';
import {
  Contract,
  ContractInterface,
  ContractTransaction,
} from '@ethersproject/contracts';
import {
  Fetcher,
  Percent,
  Router,
  Token,
  TokenAmount,
  Trade,
  Pair,
  SwapParameters,
} from '@uniswap/sdk';
import { BigNumber, Transaction, Wallet } from 'ethers';
import { logger } from '../../services/logger';
import { percentRegexp } from '../../services/config-manager-v2';
import { Ethereum } from '../../chains/ethereum/ethereum';
import { zeroAddress } from '../../services/ethereum-base';
import { ExpectedTrade, Uniswapish } from '../../services/common-interfaces';

export class Uniswap implements Uniswapish {
  private static _instances: { [name: string]: Uniswap };
  private ethereum: Ethereum;
  private _chain: string;
  private _router: string;
  private _factoryAddress: string;
  private _routerAbi: ContractInterface;
  private _factoryAbi: ContractInterface;
  private _gasLimit: number;
  private _ttl: number;
  private chainId;
  private tokenList: Record<string, Token> = {};
  private _ready: boolean = false;
  private _poolStrings: Array<string> = [];
  private _pools: Array<Pair> = [];
  private _maxHops: number;

  private constructor(chain: string, network: string) {
    this._chain = chain;
    const config = UniswapConfig.config;
    this.ethereum = Ethereum.getInstance(network);
    this.chainId = this.ethereum.chainId;
    this._ttl = UniswapConfig.config.ttl(2);
    this._routerAbi = routerAbi.abi;
    this._factoryAbi = factoryAbi.abi;
    this._gasLimit = UniswapConfig.config.gasLimit(2);
    this._router = config.uniswapV2RouterAddress(network);
    this._factoryAddress = config.uniswapV2FactoryAddress(network);
    this._poolStrings = config.pools(network);
    this._maxHops = config.maxHops(network);
  }

  public static getInstance(chain: string, network: string): Uniswap {
    if (Uniswap._instances === undefined) {
      Uniswap._instances = {};
    }
    if (!(chain + network in Uniswap._instances)) {
      Uniswap._instances[chain + network] = new Uniswap(chain, network);
    }

    return Uniswap._instances[chain + network];
  }

  /**
   * Given a token's address, return the connector's native representation of
   * the token.
   *
   * @param address Token address
   */
  public getTokenByAddress(address: string): Token {
    return this.tokenList[address];
  }

  /**
   * The user sets an array of direct pools in their config to be used to find
   * the least expensive route for a trade. This creates the pairs to be used
   * in the route calculation. We do this on initiation because it requires
   * asynchronous network calls. This checks the pool actually exists on Uniswap.
   * If it does not, then the pair is ignored.
   */
  public async initDirectPools() {
    for (const pair of this._poolStrings) {
      const splitPair = pair.split('-');
      if (splitPair.length === 2) {
        const base = splitPair[0];
        const quote = splitPair[1];
        const baseTokenInfo = this.ethereum.getTokenForSymbol(base);
        const quoteTokenInfo = this.ethereum.getTokenForSymbol(quote);

        if (baseTokenInfo !== null && quoteTokenInfo !== null) {
          const baseToken = new Token(
            this.chainId,
            baseTokenInfo.address,
            baseTokenInfo.decimals,
            baseTokenInfo.symbol,
            baseTokenInfo.name
          );

          const quoteToken = new Token(
            this.chainId,
            quoteTokenInfo.address,
            quoteTokenInfo.decimals,
            quoteTokenInfo.symbol,
            quoteTokenInfo.name
          );

          const pool = await this.getPool(
            baseToken,
            quoteToken,
            this._factoryAddress,
            this._factoryAbi
          );

          if (pool) {
            const pair: Pair = await Fetcher.fetchPairData(
              baseToken,
              quoteToken,
              this.ethereum.provider
            );
            this._pools.push(pair);
          } else {
            logger.warning(
              `There is not a direct pool pair for ${splitPair} on ${this._chain} for Uniswap V2.`
            );
          }
        } else {
          if (baseTokenInfo === null) {
            logger.warning(
              `There is an unrecognized base token in your Uniswap V2 config for ${this._chain}: ${base}.`
            );
          } else if (quoteTokenInfo === null) {
            logger.warning(
              `There is an unrecognized quote token in your Uniswap V2 config for ${this._chain}: ${quote}.`
            );
          }
        }
      } else {
        logger.warning(
          `The pool pair ${pair} in your Uniswap V2 config for ${this._chain} is malformed. It should be a string in the format 'BASE-QUOTE'.`
        );
      }
    }
  }

  public async init() {
    if (this._chain == 'ethereum' && !this.ethereum.ready())
      throw new InitializationError(
        SERVICE_UNITIALIZED_ERROR_MESSAGE('ETH'),
        SERVICE_UNITIALIZED_ERROR_CODE
      );
    for (const token of this.ethereum.storedTokenList) {
      this.tokenList[token.address] = new Token(
        this.chainId,
        token.address,
        token.decimals,
        token.symbol,
        token.name
      );
    }

    await this.initDirectPools();

    this._ready = true;
  }

  public ready(): boolean {
    return this._ready;
  }

  /**
   * Router address.
   */
  public get router(): string {
    return this._router;
  }

  /**
   * Router smart contract ABI.
   */
  public get routerAbi(): ContractInterface {
    return this._routerAbi;
  }

  /**
   * Factory address.
   */
  public get factoryAddress(): string {
    return this._factoryAddress;
  }

  /**
   * Factory smart contract ABI.
   */
  public get factoryAbi(): ContractInterface {
    return this._factoryAbi;
  }

  /**
   * Default gas limit for swap transactions.
   */
  public get gasLimit(): number {
    return this._gasLimit;
  }

  /**
   * Default time-to-live for swap transactions, in seconds.
   */
  public get ttl(): number {
    return this._ttl;
  }

  /**
   * Gets the allowed slippage percent from configuration.
   */
  getSlippagePercentage(): Percent {
    const allowedSlippage = UniswapConfig.config.allowedSlippage(2);
    const nd = allowedSlippage.match(percentRegexp);
    if (nd) return new Percent(nd[1], nd[2]);
    throw new Error(
      'Encountered a malformed percent string in the config for ALLOWED_SLIPPAGE.'
    );
  }

  /**
   * Given the amount of `baseToken` to put into a transaction, calculate the
   * amount of `quoteToken` that can be expected from the transaction.
   *
   * This is typically used for calculating token sell prices.
   *
   * @param baseToken Token input for the transaction
   * @param quoteToken Output from the transaction
   * @param amount Amount of `baseToken` to put into the transaction
   */
  async estimateSellTrade(
    baseToken: Token,
    quoteToken: Token,
    amount: BigNumber
  ): Promise<ExpectedTrade> {
    const nativeTokenAmount: TokenAmount = new TokenAmount(
      baseToken,
      amount.toString()
    );
    logger.info(
      `Fetching pair data for ${baseToken.address}-${quoteToken.address}.`
    );

    const pair: Pair = await Fetcher.fetchPairData(
      baseToken,
      quoteToken,
      this.ethereum.provider
    );
    const trades: Trade[] = Trade.bestTradeExactIn(
      this._pools.concat([pair]),
      nativeTokenAmount,
      quoteToken,
      { maxHops: this._maxHops }
    );
    if (!trades || trades.length === 0) {
      throw new UniswapishPriceError(
        `priceSwapIn: no trade pair found for ${baseToken} to ${quoteToken}.`
      );
    }
    logger.info(
      `Best trade for ${baseToken.address}-${quoteToken.address}: ` +
        `${trades[0].executionPrice.toFixed(6)}` +
        `${baseToken.name}.`
    );
    const expectedAmount = trades[0].minimumAmountOut(
      this.getSlippagePercentage()
    );
    return { trade: trades[0], expectedAmount };
  }

  /**
   * Given the amount of `baseToken` desired to acquire from a transaction,
   * calculate the amount of `quoteToken` needed for the transaction.
   *
   * This is typically used for calculating token buy prices.
   *
   * @param quoteToken Token input for the transaction
   * @param baseToken Token output from the transaction
   * @param amount Amount of `baseToken` desired from the transaction
   */
  async estimateBuyTrade(
    quoteToken: Token,
    baseToken: Token,
    amount: BigNumber
  ): Promise<ExpectedTrade> {
    const nativeTokenAmount: TokenAmount = new TokenAmount(
      baseToken,
      amount.toString()
    );
    logger.info(
      `Fetching pair data for ${quoteToken.address}-${baseToken.address}.`
    );
    const pair: Pair = await Fetcher.fetchPairData(
      quoteToken,
      baseToken,
      this.ethereum.provider
    );
    const trades: Trade[] = Trade.bestTradeExactOut(
      this._pools.concat([pair]),
      quoteToken,
      nativeTokenAmount,
      { maxHops: this._maxHops }
    );
    if (!trades || trades.length === 0) {
      throw new UniswapishPriceError(
        `priceSwapOut: no trade pair found for ${quoteToken.address} to ${baseToken.address}.`
      );
    }
    logger.info(
      `Best trade for ${quoteToken.address}-${baseToken.address}: ` +
        `${trades[0].executionPrice.invert().toFixed(6)} ` +
        `${baseToken.name}.`
    );

    const expectedAmount = trades[0].maximumAmountIn(
      this.getSlippagePercentage()
    );
    return { trade: trades[0], expectedAmount };
  }

  /**
   * Given a wallet and a Uniswap trade, try to execute it on blockchain.
   *
   * @param wallet Wallet
   * @param trade Expected trade
   * @param gasPrice Base gas price, for pre-EIP1559 transactions
   * @param uniswapRouter Router smart contract address
   * @param ttl How long the swap is valid before expiry, in seconds
   * @param abi Router contract ABI
   * @param gasLimit Gas limit
   * @param nonce (Optional) EVM transaction nonce
   * @param maxFeePerGas (Optional) Maximum total fee per gas you want to pay
   * @param maxPriorityFeePerGas (Optional) Maximum tip per gas you want to pay
   */
  async executeTrade(
    wallet: Wallet,
    trade: Trade,
    gasPrice: number,
    uniswapRouter: string,
    ttl: number,
    abi: ContractInterface,
    gasLimit: number,
    nonce?: number,
    maxFeePerGas?: BigNumber,
    maxPriorityFeePerGas?: BigNumber
  ): Promise<Transaction> {
    const result: SwapParameters = Router.swapCallParameters(trade, {
      ttl,
      recipient: wallet.address,
      allowedSlippage: this.getSlippagePercentage(),
    });

    const contract: Contract = new Contract(uniswapRouter, abi, wallet);
    if (nonce === undefined) {
      nonce = await this.ethereum.nonceManager.getNonce(wallet.address);
    }
    let tx: ContractTransaction;
    if (maxFeePerGas !== undefined || maxPriorityFeePerGas !== undefined) {
      tx = await contract[result.methodName](...result.args, {
        gasLimit: gasLimit.toFixed(0),
        value: result.value,
        nonce: nonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
    } else {
      tx = await contract[result.methodName](...result.args, {
        gasPrice: (gasPrice * 1e9).toFixed(0),
        gasLimit: gasLimit.toFixed(0),
        value: result.value,
        nonce: nonce,
      });
    }

    logger.info(tx);
    await this.ethereum.nonceManager.commitNonce(wallet.address, nonce);
    return tx;
  }

  /**
   * Check if a pool exists for a pair of ERC20 tokens.
   *
   * @param quoteToken Quote Token
   * @param baseToken Base Token
   * @param factory Factory smart contract adress
   * @param abi Factory contract interface
   */
  async getPool(
    tokenA: Token,
    tokenB: Token,
    factory: string,
    abi: ContractInterface
  ): Promise<string | null> {
    const contract: Contract = new Contract(
      factory,
      abi,
      this.ethereum.provider
    );
    const pairAddress: string = await contract['getPair'](
      tokenA.address,
      tokenB.address
    );

    return pairAddress !== zeroAddress ? pairAddress : null;
  }

  /**
   * Return the list of pools used to check a price or make a trade.
   *
   * @param trade Uniswap trade
   */
  getTradeRoute(trade: Trade): string[] {
    const path = [];

    if ('path' in trade.route) {
      let prevTokenSymbol: string | null = null;
      for (const token of trade.route.path) {
        const currentTokenSymbol = token.symbol;
        if (currentTokenSymbol !== undefined) {
          if (prevTokenSymbol !== null) {
            path.push(`${prevTokenSymbol}-${currentTokenSymbol}`);
          }
          prevTokenSymbol = currentTokenSymbol;
        }
      }
    }
    return path;
  }
}
