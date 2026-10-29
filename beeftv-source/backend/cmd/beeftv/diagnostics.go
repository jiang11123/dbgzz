package main

import (
	"flag"
	"io"
	"os"

	"infinite-canvas/backend/internal/diagnostics"
)

func runDiagnostics(args []string) error {
	if len(args) == 0 || args[0] != "analyze" {
		return &cliError{code: exitUsage, reason: "invalid_diagnostics_command", msg: "用法：beeftv diagnostics analyze --file <diagnostics.zip>"}
	}
	flags := flag.NewFlagSet("diagnostics analyze", flag.ContinueOnError)
	file := flags.String("file", "", "诊断 ZIP 文件")
	if err := flags.Parse(args[1:]); err != nil {
		return flagError(err)
	}
	if *file == "" || flags.NArg() != 0 {
		return &cliError{code: exitUsage, reason: "diagnostics_file_required", msg: "请通过 --file 指定诊断 ZIP 文件"}
	}
	f, err := os.Open(*file)
	if err != nil {
		return &cliError{code: exitNotFound, reason: "diagnostics_file_unavailable", msg: "无法读取诊断文件"}
	}
	defer f.Close()
	// The product exports at most 10 MiB; bound hostile offline inputs too.
	const maxInput = 16 << 20
	body, err := io.ReadAll(io.LimitReader(f, maxInput+1))
	if err != nil || len(body) > maxInput {
		return &cliError{code: exitBadRequest, reason: "diagnostics_input_invalid", msg: "诊断文件无法读取或超过 16 MiB"}
	}
	findings, err := diagnostics.AnalyzeBundle(body)
	if err != nil {
		return &cliError{code: exitBadRequest, reason: "diagnostics_bundle_invalid", msg: "诊断包损坏或格式不受支持，需要 schema 3 诊断包"}
	}
	return emitJSON(findings)
}
