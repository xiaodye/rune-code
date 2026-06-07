/**
 * 将字符串首字母大写
 * @param str 输入字符串
 * @returns 首字母大写后的字符串
 */
export function capitalize(str: string): string {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
}
