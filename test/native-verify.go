// Optional independent consensus check. Run from the pinned Pearl Go checkout:
// go run /absolute/path/to/prl-hub-wallet/test/native-verify.go < signed-fixtures.json
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	"github.com/pearl-research-labs/pearl/node/btcutil"
	"github.com/pearl-research-labs/pearl/node/chaincfg"
	"github.com/pearl-research-labs/pearl/node/chaincfg/chainhash"
	"github.com/pearl-research-labs/pearl/node/txscript"
	"github.com/pearl-research-labs/pearl/node/wire"
)

type fixture struct {
	Hex string `json:"hex"`
	Network string `json:"network"`
	UTXOs []struct {
		Txid string `json:"txid"`
		Vout uint32 `json:"vout"`
		Value string `json:"value"`
		Address string `json:"address"`
	} `json:"utxos"`
}
func main() {
	var fixtures []fixture
	if err := json.NewDecoder(os.Stdin).Decode(&fixtures); err != nil { panic(err) }
	inputs := 0
	for _, f := range fixtures {
		params := &chaincfg.MainNetParams
		if f.Network == "testnet" { params = &chaincfg.TestNet2Params }
		raw, err := hex.DecodeString(f.Hex); if err != nil { panic(err) }
		var tx wire.MsgTx
		if err := tx.Deserialize(bytes.NewReader(raw)); err != nil { panic(err) }
		fetcher := txscript.NewMultiPrevOutFetcher(nil)
		for _, u := range f.UTXOs {
			h, err := chainhash.NewHashFromStr(u.Txid); if err != nil { panic(err) }
			a, err := btcutil.DecodeAddress(u.Address, params); if err != nil { panic(err) }
			script, err := txscript.PayToAddrScript(a); if err != nil { panic(err) }
			value, err := strconv.ParseInt(u.Value, 10, 64); if err != nil { panic(err) }
			fetcher.AddPrevOut(wire.OutPoint{Hash:*h, Index:u.Vout}, wire.NewTxOut(value, script))
		}
		hashes := txscript.NewTxSigHashes(&tx, fetcher)
		for i, in := range tx.TxIn {
			prev := fetcher.FetchPrevOutput(in.PreviousOutPoint)
			vm, err := txscript.NewEngine(prev.PkScript, &tx, i, txscript.StandardVerifyFlags, nil, hashes, prev.Value, fetcher)
			if err != nil { panic(err) }; if err := vm.Execute(); err != nil { panic(err) }; inputs++
		}
	}
	fmt.Printf("Pearl consensus: %d signed transactions / %d inputs valid\n", len(fixtures), inputs)
}
