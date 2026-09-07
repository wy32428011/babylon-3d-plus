/** GLB 2.0使用32位总长度且chunk按4字节对齐；文件流/结构检查不再使用512MiB业务截断。 */
export const MAX_GLB_FILE_BYTES = 0xffff_fffc;

export const GLB_FILE_SIZE_LIMIT_MESSAGE = '超过 GLB 2.0 容器上限（约 4 GiB），请将环境按完整模型分块后导入';
