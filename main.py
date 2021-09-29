import pysubs2
import argparse
import os
import sys
import glob

def main(): 
    args_parser = argparse.ArgumentParser()
    args_parser.add_argument('input_directory')
    args = args_parser.parse_args()

    if not os.path.isdir(args.input_directory):
        print(f'Not a valid directory: {args.input_directory}', file=sys.stderr)
        return
    
    glob_path = os.path.join(args.input_directory, '*.vtt')
    vtt_files = glob.glob(glob_path)

    print(f'Found {len(vtt_files)} with glob {glob_path}')

    for vtt_file in vtt_files:
        print(f'Began processing {vtt_file}')
        vtt = pysubs2.load(vtt_file)
        print(f'{len(vtt)} lines in {vtt_file}')
        #vtt.remove_miscellaneous_events()

        for line in vtt:
            line.text = line.text.replace('&lrm;', '')
        
        root, ext = os.path.splitext(vtt_file)
        srt_file = root + '.srt'
        vtt.save(srt_file, format_='srt')
        print(f'Saved {srt_file}')
        
main()