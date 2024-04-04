export type SuiNetworks = 'mainnet' | 'testnet'

// Sui mainnet RPC URL.
// When used in production, this should be a secret stored in `.envrc`, and not entered here.
export const SUI_MAINNET_RPC_URL: string =
    'https://sui-mainnet.blastapi.io/4b683e6d-eed6-4b10-a959-e4dffff85001'

export function getFullnodeUrl(
    network: 'mainnet' | 'testnet' | 'devnet' | 'localnet'
): string {
    switch (network) {
        case 'mainnet': {
            return SUI_MAINNET_RPC_URL
        }
        default: {
            throw new Error('Currently unsupported network')
        }
    }
}
