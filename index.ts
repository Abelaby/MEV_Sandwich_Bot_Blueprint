import { Wallet, ethers, providers } from "ethers";
import { FlashbotsBundleProvider, FlashbotsBundleResolution } from "@flashbts/ethers-provider-bundle"

// ABIs and ByteCodes
const UniswapAbi = [];
const UniswapBytecode = ""
const UniswapFactoryAbi = []
const UniswapFactoryBytecode = ""
const pairAbi = []
const pairBytecode =""
const erc20Abi = []
const erc20Bytecode = ""
const UniswapV3Abi = []


// Variables
const flashbotsUrl = ""
const wethAddress = ""
const uniswapAddress = "" //UniswapV2ROuter02
const UniswapFactoryAddress = ""
const universalRouterAddress = ""
const httpProviderUrl = ""
const wsProviderUrl = ""
const privateKey = ""

// const provider, can be used for not mempool transactions 
const wsProvider = new ethers.providers.WebSocketProvider(wsProviderUrl)
const bribeToMiners = ethers.utils.parseUnits('20', 'gwei')
const buyAmount = ethers.utils.parseUnits('0.1', 'ether')

// contract and providers
const signingWallet  = new Wallet(privateKey).connect(wsProvider)
const UniswapV3Interface = new ethers.utils.Interface(UniswapAbi)
const  factoryUniswapFactory = new ethers.ContractFactory(UniswapFactoryAbi, UniswapFactoryBytecode, signingWallet ).attach(UniswapFactoryAddress)
const erc20Factory = new ethers.ContractFactory(erc20Abi, erc20Bytecode, signingWallet)
const pairFactory =  new ethers.ContractFactory(pairAbi, pairBytecode, signingWallet)
const Uniswap = new ethers.ContractFactory(UniswapAbi, UniswapBytecode, signingWallet).attach(uniswapAddress)
let flashbotsProvider = null
let chainId = 5 // goerli


// decode Uniswap router transactions
const decodeUniversalRouterSwap = input => {
    const abiCoder = new ethers.utils.AbiCoder()
    const decodesparameters = abiCoder.decode(['address','uint256','bytes', 'bool'], input)
    const breakdown = input.substring[2].match(/.{1,64}/g)

    let path = []
    let hasTwoPath = true
    if (breakdown.length != 9){
        const pathOne = '0x' + breakdown[breakdown.length - 2].substring(24)
        const pathTwo = '0x' + breakdown[breakdown.length - 1].substring(24)
        path = [pathOne, pathTwo]
    }else {
        hasTwoPath = false
    }
    return {
        recipient: parseInt(decodesparameters[0, 16]),
        amountIn: decodesparameters[1],
        minAmountOut: decodesparameters[2],
        path,
        hasTwoPath,
    }
}

// intial checks
const initialChecks =async tx=> {
    let transaction = null
    let decoded = null
    let decodedSwap = null
    try{
        transaction = await providers.getTransaction(tx)
    }
    catch (e){
        return false
    }
    if(
        !transaction
        || !transaction.to 
    )return false
    if(Number(transaction.value)== 0)return false
    
    //check if transaction is sending to UniversalRouter 
    if (transaction.to.toLowerCase() != universalRouterAddress.toLowerCase()){
        return false
    }

    //console.log(transaction)
    try{
      decoded = UniswapV3Interface.parseTransaction(transaction)
    }catch(e){
        return false
    }

    //console.log(decoded)
    // if swaP IS NOT FOR uNISWAP V2 WE RETURN IT
    if (!decoded.args.commands.includes('08')) return false
    let swapPositionInCommands = decoded.args.commands.substring(2).indexOf('08') / 2
    let inputPosition = decoded.args.inputs[swapPositionInCommands]
    decodedSwap = decodeUniversalRouterSwap(inputPosition)
    //make sure eth is being swapped
    if (!decodedSwap.hasTwoPath) return false
    if (decodedSwap.recipient === 2 ) return false
    if (decodedSwap.path[0].toLowerCase() != wethAddress.toLowerCase()) return false

    return {
        transaction,
        amountIn: transaction.value,
        minAmountOut: decodedSwap.minAmountOut,
        tokenToCapture : decodedSwap.path[1],
    }
}


// process transaction
const processTransaction = async tx =>{
     const checksPassed = await initialChecks(tx)
     if (!checksPassed) return false
    //console.log('checksPassed', checksPassed)
    const {
        transaction,
        amountIn,
        minAmountOut,
        tokenToCapture
    } = checksPassed
     // get and sort the reserves
     const pairAddress = await factoryUniswapFactory.getPair(wethAddress, tokenToCapture)
     const pair = pairFactory.attach(pairAddress)
     let reserves = null
     try {
        reserves = await pair.getReserves()
     } catch (e) {
        return false
     }
     let a
     let b 
     if (wethAddress < tokenToCapture){
        a = reserves._reserve0
        b = reserves._reserve1
     }else{
        a = reserves._reserve1
        b = reserves._reserve0
     }
     // get fee costs for simplicity and we'll add the Users's gas fee
     const maxGasFee = transaction.maxFeePerGas ? transaction.maxFeePerGas.add(bribeToMiners) : bribeToMiners
     const priorityFee = transaction.maxPriorityFeePergas.add(bribeToMiners)

     // buy using the amountIn and calculate amount out
     let firstAmountOut = await Uniswap.getAmountOut(buyAmount, a, b)
     const updatedReserveA = a.add(buyAmount)
     const updatedReserveB = b.add(firstAmountOut)
     let secondBuyAmount = await Uniswap.getAmountOut(amountIn, updatedReserveA, updatedReserveB)
     if (secondBuyAmount.lt(minAmountOut)) return console.log('victim will get less than the minimum')
    const updatedReserveA2 = updatedReserveA.add(amountIn)
    const updatedReserveB2 = updatedReserveB.add(secondBuyAmount)
    //how much ETh we get at the end with a potential profit
    let thirdAmountOut = await Uniswap.getAmountOut(firstAmountOut, updatedReserveB2,updatedReserveA2)
     // Prepare  first transaction
     const deadline = Math.floor(Date.now() / 1000) + 60 * 60 // 1 hour from now
     let firstTransaction = {
        signer: signingWallet,
        transaction: await Uniswap.populateTransaction.swapExactETHForTokens({
            firstAmountOut,
            [
                wethAddress,
                tokenToCapture,
            ],
            signingWallet.address,
            deadline,
            {
                value: buyAmount,
                type: 2,
                maxFeeperGas: maxGasFee,
                maxPriorityFeePerGas: priorityFee,
                gasLimit: 300000,
            }
        })
     } 
     firstTransaction.transaction = {
        ...firstTransaction.transaction,
        chainId,
    }
    // second transaction
    const victimsTransactionWithChainId = {
        chainId,
        ...transaction,
    }
    const signedMiddleTransaction = {
        signedTransaction: ethers.utils.serializeTransaction(victimsTransactionWithChainId,{
            r:victimsTransactionWithChainId.r,
            s:victimsTransactionWithChainId.s,
            v:victimsTransactionWithChainId.v,
        })
    }

    // prepare third transaction for the approval
    const erc20 = erc20Factory.attach(tokenToCapture)
    let thirdTransaction = {
        signer: signingWallet,
        transaction: await erc20.populateTransaction.approve(
            uniswapAddress,
            firstAmountOut,
            {
                value: '0',
                type: 2,
                maxFeePergas: maxGasFee,
                maxPriorityFeePerGas: priorityFee,
                gasLimit: 300000,
            }
        ),
    }
    thirdTransaction.transaction = {
        ...thirdTransaction.transaction,
        chainId,
    }
   // prepare final transaction to swap tokens for final ETH
   let fourthTransaction = {
    signer: signingWallet,
    transaction: await Uniswap.populateTransaction.swapExactTokensForETH(
        firstAmountOut,
        thirdAmountOut,
        [
            tokenToCapture,
            wethAddress,
        ],
      signingWallet.address,
      deadline,
      {
        value: '0',
        type: 2,
        maxFeePergas: maxGasFee,
        maxPriorityFeePerGas: priorityFee,
        gasLimit: 300000,
    }
    )
   }
   fourthTransaction.transaction = {
    ...fourthTransaction.transaction,
    chainId,
}

const transactionsArray = [
    firstTransaction,
    signedMiddleTransaction,
    thirdTransaction,
    fourthTransaction
]
const signedTransactions = await flashbotsProvider.signBundle(transactionsArray)
const blockNumber = await providers.getBlockNumber()
console.log('Simulating ... ')
const simulation = await flashbotsProvider.simulate(
    signedTransactions,
    blockNumber + 1,
    
)
if (simulation.firstRevert) {
    return console.log('Simulation error',simulation.firstRevert)
}else {
    console.log('Simulation success', simulation)
}
 // send transaction using flashbots
 let bundleSubmission 
 flashbotsProvider.sendRawBundle(
    signedTransactions, 
    blockNumber + 1,
 ).then(_bundleSubmission => {
    bundleSubmission = _bundleSubmission
    console.log("Bundle submitted", bundleSubmission.bundleHash)
    return bundleSubmission.wait()
 }).then(async waitResponse => {
    console.log( "Wait response", FlashbotsBundleResolution[waitResponse])
    if(waitResponse == FlashbotsBundleResolution.BundleIncluded){
        console.log('------------------------')
        console.log('------------------------')
        console.log('------------------------')
        console.log('-----Bundle Included----')
        console.log('------------------------')
        console.log('------------------------')
    }else if(waitResponse == FlashbotsBundleResolution.AccountNonceTooHigh){
        console.log('The trnsaction has been confirmed already')
    }else{
        console.log('Bundle hash', bundleSubmission.bundleHash)
        try {
            console.log({
                bundleStats: await flashbotsProvider.getBundleStats(
                    bundleSubmission.bundleHash,
                    blockNumber +1 ,
      
                ), 
                userStats: await flashbotsProvider.getUserstats(),

            })
        } catch (e) {
            return false
        }
    }
 })
}

// Listen to transactions in mempool


const start = async () => {
    flashbotsProvider = await FlashbotsBundleProvider(providers, signingWallet, flashbotsUrl )
    console.log('Listening on transaction for the chain id', chainId)
    wsProvider.on('pending', tx => {
       // console.log(tx)
        processTransaction(tx)
    })
}

//To do
//- calculate gas costs
//- Estimate next base fee
//- Use multiple block builders besides flashbots
//- Reduce gas costs by using assembly yul/ huff contract
//- Use multiple cores form computer to improve performance
//- Calculate the trnsaction array for type 0 and type 2 trnsactions
//- implement in multiple DEX like sushiswap, shibaswap etc..
//- calculate pair addresses locally without blockchain query
//- calculate the exact amount you'll get in profit after the first, middle and last trade without a request and without loops