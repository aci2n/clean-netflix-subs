import pysubs2
import argparse
import os
import sys
import glob
import re
import pathlib


def main():
    args_parser = argparse.ArgumentParser()
    args_parser.add_argument('input_directory')
    args = args_parser.parse_args()

    if not os.path.isdir(args.input_directory):
        print(
            f'Not a valid directory: {args.input_directory}', file=sys.stderr)
        return

    output_directory = os.path.join(args.input_directory, 'out')
    print(f'Output directory: {output_directory}')

    glob_path = os.path.join(args.input_directory, '*.vtt')
    vtt_files = glob.glob(glob_path)
    print(f'Found {len(vtt_files)} with glob {glob_path}')

    season_re = re.compile('(.*)\.S\d+E\d+')
    clean_name_re = re.compile('(.*)\.WEBRip\.Netflix')

    for vtt_file in vtt_files:
        print(f'Began processing {vtt_file}')

        vtt_file_basename = os.path.basename(vtt_file)
        vtt_file_root, _ = os.path.splitext(vtt_file_basename)
        show_folder = vtt_file_root

        clean_name_match = clean_name_re.match(show_folder)
        if clean_name_match != None:
            show_folder = clean_name_match.group(1)

        season_re_match = season_re.match(show_folder)
        if season_re_match != None:
            show_folder = season_re_match.group(1)

        show_folder = show_folder.rstrip('.')
        srt_folder = os.path.join(output_directory, show_folder)
        pathlib.Path(srt_folder).mkdir(parents=True, exist_ok=True)
        srt_file = os.path.join(srt_folder, vtt_file_root + '.srt')

        if not os.path.isfile(srt_file):
            vtt = pysubs2.load(vtt_file)
            print(f'{len(vtt)} lines in {vtt_file}')
            # vtt.remove_miscellaneous_events()

            for line in vtt:
                line.text = line.text.replace('&lrm;', '')

            vtt.save(srt_file, format_='srt')
            print(f'Saved {srt_file}')


main()
