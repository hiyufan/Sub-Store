import YAML from '@/utils/yaml';

const MIHOMO_TARGETS = new Set(['meta', 'clashmeta', 'clash.meta', 'mihomo']);
const RULE_SOURCES = [
    ['ads', 'domain', 'geosite/category-ads-all.mrs'],
    ['cn-domain', 'domain', 'geosite/cn.mrs'],
    ['non-cn-domain', 'domain', 'geosite/geolocation-!cn.mrs'],
    ['cn-ip', 'ipcidr', 'geoip/cn.mrs'],
];

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
    // Groups and nodes share a namespace, including all routing groups.
    const occupied = new Set(names);
    const allocate = (label) => {
        let name = label;
        for (let suffix = 2; occupied.has(name); suffix++)
            name = `${label} (${suffix})`;
        occupied.add(name);
        return name;
    };
    const group = allocate('节点选择');
    const basic = profile === 'basic';
    const domestic = allocate('国内流量');
    const foreign = allocate('国外流量');
    const ads = allocate('广告拦截');
    const fallback = allocate('漏网之鱼');
    const select = (name, choices) => ({
        name,
        type: 'select',
        proxies: choices,
    });
    const providers = Object.fromEntries(
        RULE_SOURCES.map(([name, behavior, resource]) => [
            name,
            {
                type: 'http',
                behavior,
                format: 'mrs',
                interval: 86400,
                url: `https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/${resource}`,
                path: `./rule-providers/sub-store-${name}.mrs`,
                // Explicit proxy avoids routing the initial rule download through rules
                // which have not been downloaded yet, and permits access behind blocks.
                proxy: group,
            },
        ]),
    );

    return YAML.safeDump(
        {
            'mixed-port': 7890,
            'allow-lan': false,
            mode: 'rule',
            'log-level': 'info',
            proxies,
            'proxy-groups': [
                select(group, names),
                ...(basic
                    ? []
                    : [
                          select(domestic, ['DIRECT', group]),
                          select(foreign, [group, 'DIRECT']),
                          select(ads, ['REJECT', 'DIRECT']),
                          select(fallback, [group, 'DIRECT']),
                      ]),
            ],
            ...(basic ? {} : { 'rule-providers': providers }),
            rules: [
                'DOMAIN,localhost,DIRECT',
                'DOMAIN-SUFFIX,local,DIRECT',
                'DOMAIN-SUFFIX,lan,DIRECT',
                'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
                'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
                'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
                'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
                'IP-CIDR6,::1/128,DIRECT,no-resolve',
                'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
                'IP-CIDR6,fe80::/10,DIRECT,no-resolve',
                ...(basic
                    ? []
                    : [
                          `RULE-SET,ads,${ads}`,
                          `RULE-SET,cn-domain,${domestic}`,
                          `RULE-SET,non-cn-domain,${foreign}`,
                          `RULE-SET,cn-ip,${domestic}`,
                      ]),
                `MATCH,${basic ? group : fallback}`,
            ],
        },
        { lineWidth: -1 },
    );
}
