import type { VercelRequest, VercelResponse } from "@vercel/node";
import { providers, Wallet, Contract } from "ethers";
import { formatUnits, parseEther } from "ethers/lib/utils";
import createFetch from "@vercel/fetch";
import {
  TransactionReceipt,
  TransactionRequest,
  TransactionResponse,
} from "@ethersproject/abstract-provider";
const fetch = createFetch();

const concaveRPC = `https://rpc.concave.lol/v1/${process.env.CONCAVE_RPC_KEY}`;
const provider = new providers.JsonRpcProvider(concaveRPC, "mainnet");

const rebaser = new Wallet(process.env.PK, provider);

const StakingContract = new Contract(
  "0x93c3a816242e50ea8871a29bf62cc3df58787fbd",
  [
    "function rebase() external returns (bool)",
    "function rebaseInterval() public view returns (uint256)",
    "function lastRebaseTime() public view returns (uint256)",
    "function rebaseIncentive() public view returns (uint256)",
  ],
  rebaser
);

const rebaseUrl = "https://concaver.vercel.app/api/rebase";
const zeploKey = process.env.ZEPLO_KEY;

const scheduleRebase = async (nextRebaseTimestamp) => {
  // will retry 3 times spaced 14 secs on failed request
  if (process.env.NODE_ENV === "development") return;
  return fetch(
    `https://zeplo.to/${rebaseUrl}?_delay_until=${nextRebaseTimestamp}&_retry=3|fixed|14&_token=${zeploKey}`
  );
};

const fetchCnvPriceWei = () =>
  fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=concave&vs_currencies=eth`
  )
    .then((a) => a.json())
    .then((d: any) => parseEther(d.concave.eth.toString()));

export default async function (req: VercelRequest, res: VercelResponse) {
  console.log("yo");

  try {
    const [rebaseIncentive, rebaseInterval, lastRebaseTime, block, gasPrice] =
      await Promise.all([
        StakingContract.rebaseIncentive(),
        StakingContract.rebaseInterval(),
        StakingContract.lastRebaseTime(),
        provider.getBlock(provider.blockNumber),
        provider.getGasPrice(),
      ]);

    const nextRebaseTime = lastRebaseTime.add(rebaseInterval);

    // block time > next rebase time, we can rebase
    if (nextRebaseTime.gte(block.timestamp)) {
      // called too early
      // maybe check if there is a schedule for the next rebase
      res.status(500).send(`it's not time yet`);
      return;
    }

    if (rebaseIncentive.eq(0)) {
      res.status(200).send(`rebase incentive is disabled`);
      return;
    }

    const simulation = await StakingContract.callStatic.rebase();
    if (simulation === false) {
      // someone frontrun us
      await scheduleRebase(nextRebaseTime);
      return res.status(200).send(`already rebased`);
    }

    const gasEstimation = await StakingContract.estimateGas.rebase();
    const cnvPriceWei = await fetchCnvPriceWei();
    const incentiveValue = cnvPriceWei.mul(+formatUnits(rebaseIncentive, 18));
    const txPrice = gasEstimation.mul(gasPrice);

    if (txPrice.gt(incentiveValue.div(2))) {
      // 5 min
      await scheduleRebase(Date.now() / 1000 + 5 * 60);
      return res.status(200).send(`
        gas too high retrying in 5 min <br/>
        <br/>
        cnv price:           ${formatUnits(cnvPriceWei, "gwei")} gwei<br/>
        incentive value:     ${formatUnits(incentiveValue, "gwei")} gwei<br/>
        tx price estimation: ${formatUnits(txPrice, "gwei")} gwei<br/>
        gas price:           ${formatUnits(gasPrice, "gwei")} gwei<br/>
      `);
    }

    const rebase: TransactionResponse = await StakingContract.rebase();
    const txResponse = await rebase.wait();
    if (txResponse.status === 1) {
      await scheduleRebase(nextRebaseTime);
      return res.status(200).send("rebase successful!");
    }

    console.log(rebase);
    res.status(500).send(`rebase was not successful`);
  } catch (e) {
    console.log(e.message);

    res.status(500).send(e.message);
  }
}
