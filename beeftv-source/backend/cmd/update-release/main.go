// Command update-release packages and signs BeefTV desktop updater artifacts.
// It is a standalone maintainer CLI and does not import the desktop runtime.
package main

import (
	"fmt"
	"io"
	"os"
)

const usageText = `usage: update-release <command> [flags]

Commands:
  gen-key            Generate an Ed25519 updater keypair into explicit files
  public-key         Print the base64 public key derived from a private key
  package            Zip a built desktop bundle with a safe updater layout
  sign               Write a signed desktop-update.json envelope
  verify             Verify a signed envelope against a public key
  changelog          Extract ## VERSION notes from CHANGELOG.md
  validate-version   Check a stable vMAJOR.MINOR.PATCH release version
  print-ldflags      Print Wails/Go ldflags that inject feed URL and public key
  sign-depth         Sign a Windows depth runtime manifest
  verify-depth       Verify a signed Windows depth runtime manifest

The private key is never written to stdout or stderr. Generate it only to an
explicit file with mode 0600. Production publishing uses GitHub secret
BEEFTV_UPDATER_PRIVATE_KEY and repository variable BEEFTV_UPDATER_PUBLIC_KEY.
`

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "%s\n", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		_, err := io.WriteString(stdout, usageText)
		return err
	}
	switch args[0] {
	case "gen-key":
		return cmdGenKey(args[1:], stdout, stderr)
	case "public-key":
		return cmdPublicKey(args[1:], stdout, stderr)
	case "package":
		return cmdPackage(args[1:], stdout, stderr)
	case "sign":
		return cmdSign(args[1:], stdout, stderr)
	case "verify":
		return cmdVerify(args[1:], stdout, stderr)
	case "changelog":
		return cmdChangelog(args[1:], stdout, stderr)
	case "validate-version":
		return cmdValidateVersion(args[1:], stdout, stderr)
	case "print-ldflags":
		return cmdPrintLdflags(args[1:], stdout, stderr)
	case "sign-depth", "verify-depth":
		return cmdDepthManifest(args[0], args[1:], stdout, stderr)
	default:
		return fmt.Errorf("unknown command %q\n\n%s", args[0], usageText)
	}
}
