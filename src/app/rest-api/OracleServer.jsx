const express = require("express");
const app = express();
const http = require("http");
const contract = require("truffle-contract");
const path = require("path");
const driver = require("bigchaindb-driver");
const API_PATH = "http://localhost:59984/api/v1/";
const conn = new driver.Connection(API_PATH);
const Web3 = require("web3");
const codes = require("./error_codes.js");
let bodyParser = require("body-parser");
const PaymentJSON = require(path.join(
    __dirname,
    "../../../build/contracts/Payment.json"
));

let web3;
const ERROR_STATUS = "FAILURE";

// Add headers
app.use(function (req, res, next) {
    // Website you wish to allow to connect
    res.setHeader("Access-Control-Allow-Origin", "http://localhost:4200");

    // Request methods you wish to allow
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, OPTIONS, PUT, PATCH, DELETE"
    );

    // Request headers you wish to allow
    res.setHeader(
        "Access-Control-Allow-Headers",
        "X-Requested-With,content-type"
    );

    // Set to true if you need the website to include cookies in the requests sent
    // to the API (e.g. in case you use sessions)
    res.setHeader("Access-Control-Allow-Credentials", true);

    // Pass to next layer of middleware
    next();
});

app.use(bodyParser.json()); // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({extended: true}));

app.post("/exec/create", async (request, res, next) => {
    let containerID = request.body.id;
    let swIPFSHash = request.body.swIpfsHash;
    let datasetBdbTxID = request.body.datasetBdbId;
    let userPubKey = request.body.pubUserKey;

    console.log(containerID);
    console.log(swIPFSHash);
    console.log(datasetBdbTxID);
    console.log(userPubKey);

    // let swAssets = await conn.searchAssets(swIpfsHash);
    let datasetAssets = await conn.searchAssets(datasetBdbTxID);

    if (datasetAssets.length === 0) {
        res.send([ERROR_STATUS, codes.getErrorMessage(300)]);
        return next();
    }

    let commands = ["./wrapper.sh", datasetBdbTxID, swIPFSHash, userPubKey];
    let bodyCmd = JSON.stringify({
        Cmd: commands,
        AttachStdout: true
    });

    let path = "/containers/" + containerID + "/exec";
    let post_options = {
        socketPath: "/var/run/docker.sock",
        path: path,
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyCmd)
        }
    };
    new Promise(resolve => {
        let post_req = http.request(post_options, function (res) {
            res.setEncoding("utf8");
            let status = res.statusCode;
            console.log("STATUS: " + status);

            let rawData = "";
            res
                .on("data", function (chunk) {
                    rawData += chunk;
                    console.log("Response: " + chunk);
                })
                .on("end", () => {
                    console.log("RESULT = ", rawData);
                    resolve([status, rawData]);
                })
                .on("error", e => {
                    console.log("ERROR", e);
                    resolve(1, "Failed to create exec command.");
                });
        });
        post_req.write(bodyCmd);
    }).then(([status, msg]) => {
        console.log([status, msg]);
        let error_codes_array = codes.getErrorCodes();
        if (error_codes_array.includes(parseInt(status))) {
            console.log("ERROR");
            res.send([ERROR_STATUS, codes.getErrorMessage(parseInt(status))]);
        } else {
            res.send([status, msg]);
        }

    });
});

app.post("/exec/run", (request, res) => {
    let execID = request.body.execId;
    let paymentID = request.body.paymentID;

    console.log("[Exec ID]", execID);

    let bodyCmd = JSON.stringify({});
    let post_options = {
        socketPath: "/var/run/docker.sock",
        path: "/exec/" + execID + "/start",
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyCmd)
        }
    };

    new Promise(resolve => {
        let post_req = http.request(post_options, function (res) {
            // res.setEncoding("utf8");
            let status = res.statusCode;
            console.log("STATUS: " + status);

            let output = "";

            res.on("data", function (chunk) {
                console.log("Response:" + chunk);
                output += chunk;
            });

            res.on("end", () => {
                console.log("RESULT:", output);
                if(status === 200)
                    resolve(output);
                else
                    resolve(status);
            });

            res.on("error", e => {
                console.log("ERROR", e);
                resolve(1, "Failed to run exec command.");
            });
        });
        post_req.write(bodyCmd);
        post_req.end();
    }).then(async msg => {
        try {
            msg = msg.replace(/[\u0001\u0000\u0004]/g, "");
            msg = msg.trim();
            let error_codes_array = codes.getErrorCodes();

            if (error_codes_array.includes(parseInt(msg))) {
                let error_msg = codes.getErrorMessage(parseInt(msg));
                await revertPayment(paymentID);
                res.send(["Failure", error_msg]);
            } else {
                await execPayment(paymentID);
                msg = msg.replace(/\//g, ""); // remove / from ipfs address result
                res.send(["Success", msg]);
            }
        } catch (e) {
            await revertPayment(paymentID);
            console.log("Returning funds...");
            res.send(["Failure", "Funds returned"]);
        }
    });
});

async function revertPayment(paymentID) {
    let accounts = await web3.eth.getAccounts();
    let currentAccount = accounts[9];
    let PaymentContract = initContract(PaymentJSON);
    let deployedPayment = await PaymentContract.deployed();
    try {
        let success = await deployedPayment.returnFunds(paymentID, {from: currentAccount});
    } catch (e) {
        console.log(e);
    }
}

async function execPayment(paymentID) {
    let accounts = await web3.eth.getAccounts();
    let currentAccount = accounts[9];
    let PaymentContract = initContract(PaymentJSON);
    let deployedPayment = await PaymentContract.deployed();
    try {
        let success = await deployedPayment.executePayment(paymentID, {from: currentAccount});
    } catch (e) {
        console.log(e);
    }
}

function initWeb3() {
    console.log("Initializing web3");
    if (typeof web3 !== "undefined") {
        web3 = new Web3(web3.currentProvider);
    } else {
        // set the provider you want from Web3.providers
        web3 = new Web3(new Web3.providers.HttpProvider("http://localhost:9545"));
    }
}

function initContract(artifact) {
    let MyContract = contract(artifact);
    MyContract.setProvider(web3.currentProvider);

    //dirty hack for web3@1.0.0 support for localhost testrpc, see https://github.com/trufflesuite/truffle-contract/issues/56#issuecomment-331084530
    if (typeof MyContract.currentProvider.sendAsync !== "function") {
        MyContract.currentProvider.sendAsync = function () {
            return MyContract.currentProvider.send.apply(
                MyContract.currentProvider,
                arguments
            );
        };
    }
    return MyContract;
}

initWeb3();

let server = app.listen(8081, () => {
    let host = server.address().address;
    let port = server.address().port;
    console.log("Oracle server listening at http://%s:%s", host, port);
});
