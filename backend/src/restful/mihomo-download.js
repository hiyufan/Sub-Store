import YAML from '@/utils/yaml';

const MIHOMO_TARGETS = new Set(['meta', 'clashmeta', 'clash.meta', 'mihomo']);

// A subscription download is a client profile by default. Internal producers,
// file composition and explicit provider downloads still use plain node lists.
export function formatMihomoDownload(
    output,
    { platform, profile, produceType } = {},
) {
    if (
        !MIHOMO_TARGETS.has(String(platform).toLowerCase()) ||
        profile === 'nodes' ||
        ['internal', 'raw'].includes(produceType)
    ) {
        return output;
    }

    const proxies = YAML.safeLoad(output)?.proxies;
    if (!Array.isArray(proxies) || proxies.length === 0) {
        throw new Error(
            'Clash Meta 完整配置中没有可用节点，请检查订阅来源和节点兼容性',
        );
    }
    const names = proxies.map((proxy) => proxy.name);
    if (
        names.some((name) => typeof name !== 'string' || !name.trim()) ||
        new Set(names).size !== names.length
    ) {
        throw new Error(
            'Clash Meta 完整配置需要唯一且非空的节点名称，请先重命名重复节点',
        );
    }
    // Group names share a namespace with nodes. Do not shadow a user node.
    let group = '节点选择';
    for (let suffix = 2; names.includes(group); suffix++) {
        group = `节点选择 (${suffix})`;
    }

    return YAML.safeDump(
        {
            'mixed-port': 7890,
            'allow-lan': false,
            mode: 'rule',
            'log-level': 'info',
            proxies,
            'proxy-groups': [{ name: group, type: 'select', proxies: names }],
            rules: [
                'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
                'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
                'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
                'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
                'IP-CIDR6,::1/128,DIRECT,no-resolve',
                'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
                'IP-CIDR6,fe80::/10,DIRECT,no-resolve',
                `MATCH,${group}`,
            ],
        },
        { lineWidth: -1 },
    );
}
